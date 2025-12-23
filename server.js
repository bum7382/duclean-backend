require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors());
app.use(express.json());

// 알람 코드 -> 문자열
const ALARM_CODE_MAP = {
		0: '알람없음',
		1: '과전류',
		2: '운전에러',
		3: '모터 역방향',
		4: '전류 불평형',
		5: '과차압',
		6: '필터교체',
		7: '저차압',
};

// 1. MongoDB 연결 및 TTL 인덱스 설정
function createTTLIndex() {
		// 30일 (30 * 24 * 60 * 60 = 2,592,000초)
		const thirtyDaysInSeconds = 2592000; 
		
		// 30일 후 자동 삭제되는 TTL 인덱스 설정
		AlarmLog.collection.createIndex(
				{ timestamp: 1 }, 
				{ expireAfterSeconds: thirtyDaysInSeconds, name: 'ttl_30_days_timestamp' },
				(err) => {
						if (err) {
								console.error('❌ TTL Index Creation Error:', err);
						} else {
								console.log('⏳ TTL Index (30 days) on timestamp field created/verified.');
						}
				}
		);
}

mongoose.connect(process.env.MONGO_URI)
	.then(() => {
		console.log('✅ MongoDB Connected');
		createTTLIndex();
		setupMqttClient();
	})
	.catch(err => console.error('❌ MongoDB Connection Error:', err));


// 2. 스키마 정의 및 모델: mac, ip, time, status, active
const AlarmSchema = new mongoose.Schema({
	timestamp: { type: Date, required: true },
	mac_address: { type: String, required: true, index: true },
	ip_address: { type: String, required: true, index: true },
		
	// 알람 데이터 필드 (문자열)
	status: { type: String, required: true },
		
	active: { type: Boolean, required: true, index: true }, // 현재 활성 상태 (미해제: true)
});

const AlarmLog = mongoose.model('AlarmLog', AlarmSchema, 'alarm');


// 3. MQTT 클라이언트 설정 및 구독
async function handleAlarmClear({ mac, ip }) {
		// 해당 MAC/IP의 모든 미해제 알람을 해제 처리 (active: false로 업데이트)
		const result = await AlarmLog.updateMany(
				{ mac_address: mac, ip_address: ip, active: true },
				{ $set: { active: false } }
		);
		if (result.modifiedCount > 0) {
				console.log(`✅ Alarm Clear: Updated ${result.modifiedCount} active logs for ${mac} to active: false.`);
		}
}

function setupMqttClient() {
		// 3.1. 브로커 정보 설정
		const BROKER_URL = 'mqtt://3.120.241.59:1883'; 
		const TOPIC = 'alarm';

		const client = mqtt.connect(BROKER_URL);

		client.on('connect', () => {
				console.log(`✅ MQTT Connected to ${BROKER_URL}`);
				
				client.subscribe(TOPIC, { qos: 0 }, (err) => {
						if (!err) {
								console.log(`📡 Subscribed to topic: ${TOPIC}`);
						} else {
								console.error('❌ MQTT Subscription Error:', err);
						}
				});
		});

		// 3.4. 메시지 수신 이벤트 처리 
		client.on('message', async (topic, message) => {
				const payload = message.toString().trim(); 
				
				// 2. 공백 기준으로 문자열을 분리 [0:날짜, 1:시간, 2:MAC, 3:IP, 4:Flag, 5:Code, 6:Count]
				const parts = payload.split(' '); 

				if (parts.length < 7) {
						console.error(`❌ MQTT Message Error: Invalid message format (parts < 7). Received: [${payload}]`);
						return; 
				}

				// 4. 데이터 추출
				const date_part = parts[0]; 
				const time_part = parts[1]; 
				const mac_address = parts[2]; 
				const ip_address = parts[3];
				const flag = parseInt(parts[4]);  // 1:발생, 0:해제
				const code = parseInt(parts[5]);	// 알람 코드 (0~7)

				// 5. 시각 생성 및 변환 (KST)
				const real_timestamp_string = `${date_part} ${time_part}`;
        const real_timestamp = new Date(real_timestamp_string);

				// 6. 알람 상태 문자열 변환
				const alarm_status_string = ALARM_CODE_MAP[code] || `알 수 없는 코드 (${code})`;
				
				try {
						console.log(`[MQTT] Received: MAC=${mac_address}, Flag=${flag}, Code=${code} (${alarm_status_string})`);

						if (flag === 0) {
								// 7-1. Flag=0: 알람 해제 요청 -> 기존 활성 로그 해제
								await handleAlarmClear({ mac: mac_address, ip: ip_address });
                
                // 7-2. 해제 이벤트 로그 생성
                // 알람 코드가 0(알람없음)인 해제 이벤트는 저장하지 않음.
                if (code === 0) {
                    console.log('ℹ️ Ignoring save: Flag=0 received with Code=0 (Redundant clear event).');
                    return;
                }

								const newClearLog = new AlarmLog({
										timestamp: real_timestamp, 
										mac_address: mac_address,
										ip_address: ip_address,
										
										status: alarm_status_string, 
										
										active: false, // 해제 이벤트
								});
								await newClearLog.save();
								console.log('💾 New Alarm Clear log saved to MongoDB (Active: false).');

								return;
						}

						// 8. Flag=1: 알람 발생 요청 (code > 0일 때만 발생으로 기록)
						if (flag === 1 && code > 0) {
								// MongoDB에 데이터 저장
								const newLog = new AlarmLog({
										timestamp: real_timestamp, 
										mac_address: mac_address,
										ip_address: ip_address,
										
										status: alarm_status_string,
										
										active: true, // 알람 발생 시 active: true
								});
								await newLog.save();
								console.log('💾 New Alarm log saved to MongoDB (Active: true).');
								
						} else if (flag === 1 && code === 0) {
								 // Flag=1이고 code=0: 알람 없음 -> 저장하지 않고 무시
								 console.log('ℹ️ Received Flag=1, Code=0 (Normal status check). Ignoring log save.');
						}

				} catch (error) {
						console.error('❌ Error saving/clearing MQTT message:', error.message);
				}
		});

		client.on('error', (err) => {
				console.error('❌ MQTT Connection Error:', err);
		});

		client.on('close', () => {
				console.log('⚠️ MQTT Connection Closed');
		});
}


// 4. API 라우트

// [GET] /api/logs: 전체 데이터 조회 
app.get('/api/logs', async (req, res) => {
	try {
		const logs = await AlarmLog.find()
			.sort({ timestamp: -1 })
			.select('mac_address ip_address timestamp status active -_id'); // 5가지 필드 조회

		res.json({
			data: logs
		});
	} catch (error) {
		console.error('조회 에러:', error);
		res.status(500).json({ success: false, message: error.message });
	}
});


// [GET] /api/logs/filter: 특정 MAC 주소 및 IP 주소로 데이터 조회 
app.get('/api/logs/filter', async (req, res) => {
		const { mac, ip, active } = req.query; 
		let query = {};

		if (mac) {
			query.mac_address = new RegExp(mac, 'i'); 
		}
		
		if (ip) {
			query.ip_address = ip; 
		}
		
		if (active !== undefined) {
			// 쿼리 파라미터는 문자열이므로 boolean으로 변환
			query.active = active.toLowerCase() === 'true'; 
		}

		if (Object.keys(query).length === 0) {
			return res.status(400).json({ 
				success: false, 
				message: "MAC, IP, 또는 Active 상태를 쿼리 파라미터로 제공해야 합니다." 
			});
		}

		try {
				console.log(`[GET FILTER] Query: ${JSON.stringify(query)}`);

				const logs = await AlarmLog.find(query)
					.sort({ timestamp: -1 })
					.select('mac_address ip_address timestamp status active -_id'); // 5가지 필드 조회
				
				res.json({
					data: logs
				});

		} catch (error) {
				console.error('필터 조회 에러:', error);
				res.status(500).json({ success: false, message: error.message });
		}
});


// 5. 서버 실행
app.listen(PORT, () => {
	console.log(`🚀 Server running on port ${PORT}`);
});