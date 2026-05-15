require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const mqtt = require('mqtt');
const { startDailyBackupCron } = require('./backup');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors());
app.use(express.json());

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
		startLogIntervalTask();
		startDailyBackupCron(Log);
	})
	.catch(err => console.error('❌ MongoDB Connection Error:', err));


// 10분마다 캐시된 최신 레지스터 값을 logs 컬렉션에 저장
const LOG_INTERVAL_MS = 10 * 60 * 1000;
function startLogIntervalTask() {
	setInterval(async () => {
		if (latestRegisterCache.size === 0) return;
		const now = new Date();
		try {
			const macs = Array.from(latestRegisterCache.keys());
			const devices = await Device.find({ mac_address: { $in: macs } })
				.select('mac_address serial -_id')
				.lean();
			const serialMap = new Map(devices.map(d => [d.mac_address, d.serial]));

			const docs = [];
			for (const [mac, val] of latestRegisterCache.entries()) {
				docs.push({
					timestamp: now,
					metadata: { mac, serial: serialMap.get(mac) || null },
					pressure: val.pressure,
					current1: val.current1,
					current2: val.current2
				});
			}
			const result = await Log.insertMany(docs);
			console.log(`💾 Logs saved: ${result.length} devices @ ${now.toISOString()}`);
		} catch (err) {
			console.error('❌ Log interval insert error:', err.message);
		}
	}, LOG_INTERVAL_MS);
	console.log(`⏱️ Log interval task scheduled (every ${LOG_INTERVAL_MS / 60000} minutes)`);
}


// 2. 스키마 정의 및 모델: mac, ip, time, status, active
const AlarmSchema = new mongoose.Schema({
	timestamp: { type: Date, required: true },
	stop_timestamp: { type: Date },
	mac_address: { type: String, required: true, index: true },
	ip_address: { type: String, required: true, index: true },
	// 알람 데이터 필드
	status: { type: Number, required: true },
	active: { type: Boolean, required: true, index: true }, // 현재 활성 상태 (미해제: true)
	serial: { type: String, required: false }
},{ 
  collection: 'alarm'
});

const AlarmLog = mongoose.model('AlarmLog', AlarmSchema);

// 디바이스 매핑 스키마
const DeviceSchema = new mongoose.Schema({
    mac_address: { type: String, required: true, unique: true },
    serial: { type: String, required: true }
});
const Device = mongoose.model('Device', DeviceSchema, 'devices');

// logs 시계열 컬렉션 (10분 주기 차압/전류 기록, 30일 후 자동 만료)
const LogSchema = new mongoose.Schema({
	timestamp: { type: Date, required: true },
	metadata: {
		mac: { type: String, required: true },
		serial: { type: String, default: null }
	},
	pressure: { type: Number },   // mmAq
	current1: { type: Number },   // A
	current2: { type: Number }    // A
}, {
	collection: 'logs',
	timeseries: {
		timeField: 'timestamp',
		metaField: 'metadata',
		granularity: 'minutes'
	},
	expireAfterSeconds: 2592000
});
const Log = mongoose.model('Log', LogSchema);


// MAC -> 가장 최근 수신한 레지스터 값 캐시 (10분 주기 logs 저장용)
const latestRegisterCache = new Map();

// MQTT payload의 hex 레지스터 덩어리를 Int16 배열 44개로 파싱
function parseRegisterHex(hexBlob) {
	if (typeof hexBlob !== 'string') return null;
	let hex = hexBlob.startsWith('0x') || hexBlob.startsWith('0X') ? hexBlob.slice(2) : hexBlob;
	if (hex.length < 176) return null;
	hex = hex.slice(0, 176);
	const registers = new Array(44);
	for (let i = 0; i < 44; i++) {
		const raw = parseInt(hex.slice(i * 4, i * 4 + 4), 16);
		if (Number.isNaN(raw)) return null;
		// Int16 signed 변환
		registers[i] = raw >= 0x8000 ? raw - 0x10000 : raw;
	}
	return registers;
}


// 3. MQTT 클라이언트 설정 및 구독
async function handleAlarmClear({ mac, ip, stopTime }) {
	// 해당 MAC/IP의 모든 미해제 알람을 해제 처리 (active: false로 업데이트)
	const result = await AlarmLog.updateMany(
			{ mac_address: mac, ip_address: ip, active: true },
			{ $set: { active: false, stop_timestamp: stopTime } }
	);
	if (result.modifiedCount > 0) {
		console.log(`✅ Alarm Clear: Updated ${result.modifiedCount} logs with stop_timestamp.`);
	}
}

function setupMqttClient() {
	// 3.1. 브로커 정보 설정
	const BROKER_URL = 'mqtt://broker.emqx.io:1883'; 
	const TOPIC = 'alarm';

	const client = mqtt.connect(BROKER_URL);
	

	client.on('connect', () => {
		console.log(`✅ MQTT Connected to ${BROKER_URL}`);
		
		client.subscribe(TOPIC, { qos: 2 }, (err) => {
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

		const rawPayload = message.toString();
		console.log(`[MQTT 수신] 토픽: ${topic}`);
		console.log(`[MQTT 수신] 내용: ${rawPayload}`);
		console.log(`[MQTT 수신] hex(${message.length}B): ${message.toString('hex')}`);
		
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
		const register_blob = parts[6];   // 0x{176 hex chars} = 레지스터 0~43

		// 5. 시각 생성 및 변환 (KST)
		const real_timestamp_string = `${date_part}T${time_part}+09:00`;
		const real_timestamp = new Date(real_timestamp_string);

		// 5.1. 레지스터 hex 파싱 → 차압/CT1/CT2 캐시 갱신
		// (register hex 덩어리가 들어왔을 때만; 옛날 포맷의 짧은 숫자 payload는 조용히 무시)
		const looksLikeRegisterHex = typeof register_blob === 'string'
			&& (register_blob.startsWith('0x') || register_blob.startsWith('0X'))
			&& register_blob.length >= 178;
		if (looksLikeRegisterHex) {
			const registers = parseRegisterHex(register_blob);
			if (registers) {
				latestRegisterCache.set(mac_address, {
					pressure: registers[0],          // mmAq, scale 1
					current1: registers[1] / 10,     // A, scale 0.1
					current2: registers[2] / 10,     // A, scale 0.1
					ip_address,
					receivedAt: real_timestamp,
				});
			} else {
				console.warn(`⚠️ Register hex parse failed for MAC=${mac_address}: ${register_blob}`);
			}
		}

		try {
			// DB에서 해당 MAC 주소에 매핑된 시리얼 넘버가 있는지 확인
			const deviceMatch = await Device.findOne({ mac_address: mac_address });
			const currentSerial = deviceMatch ? deviceMatch.serial : null;
			console.log(`[MQTT] Received: MAC=${mac_address}, Flag=${flag}, Code=${code}`);

			if (flag === 0) {
				// 7-1. Flag=0: 알람 해제 요청 -> 기존 활성 로그 해제
				await handleAlarmClear({ 
					mac: mac_address, 
					ip: ip_address, 
					stopTime: real_timestamp // MQTT에서 추출한 시각 전달
				});
				
				// 7-2. 해제 이벤트 로그 생성
				// 알람 코드가 0(알람없음)인 해제 이벤트는 저장하지 않음.
				if (code === 0) {
					console.log('ℹ️ Ignoring save: Flag=0 received with Code=0 (Redundant clear event).');
					return;
				}

				const newClearLog = new AlarmLog({
					timestamp: real_timestamp, 
					stop_timestamp: real_timestamp,
					mac_address: mac_address,
					ip_address: ip_address,
					status: code, 
					active: false,
					serial: currentSerial,
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
							status: code,
							active: true, // 알람 발생 시 active: true
							serial: currentSerial
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

// [GET] /api/logs: 데이터 조회 (mac, ip, serial 쿼리 파라미터로 필터링 가능, page/limit으로 페이지네이션)
app.get('/api/logs', async (req, res) => {
	const { mac, ip, serial } = req.query;
	const page = Math.max(parseInt(req.query.page) || 1, 1);
	const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
	const skip = (page - 1) * limit;

	const query = {};

	if (mac) {
		query.mac_address = new RegExp(mac, 'i');
	}

	if (ip) {
		query.ip_address = ip;
	}

	if (serial) {
		query.serial = new RegExp(serial, 'i');
	}

	try {
		if (Object.keys(query).length > 0) {
			console.log(`[GET /api/logs] Query: ${JSON.stringify(query)}, page: ${page}, limit: ${limit}`);
		}

		const [logs, total] = await Promise.all([
			AlarmLog.find(query)
				.sort({ timestamp: -1 })
				.skip(skip)
				.limit(limit)
				.select('mac_address ip_address timestamp stop_timestamp status active serial -_id'),
			AlarmLog.countDocuments(query)
		]);

		res.json({
			data: logs,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit)
			}
		});
	} catch (error) {
		console.error('조회 에러:', error);
		res.status(500).json({ success: false, message: error.message });
	}
});

// [GET] /api/devices: 등록된 디바이스 전체 조회 (mac/serial 필터링은 프론트에서)
app.get('/api/devices', async (req, res) => {
	try {
		const devices = await Device.find()
			.sort({ mac_address: 1 })
			.select('mac_address serial -_id');

		res.json({
			data: devices
		});
	} catch (error) {
		console.error('디바이스 조회 에러:', error);
		res.status(500).json({ success: false, message: error.message });
	}
});

// 맥 주소로 등록된 시리얼 번호 값 받아오기
app.get('/api/serial/:mac', async (req, res) => {
    const { mac } = req.params;

    try {
        // Device 컬렉션에서 해당 MAC 주소 찾기
        const device = await Device.findOne({ mac_address: mac });

        if (device) {
            res.json({ success: true, serial: device.serial });
        } else {
            res.json({ success: false, message: "등록된 시리얼 번호가 없습니다." });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4.1 [POST] /api/serial: 시리얼 넘버와 MAC 주소 매칭
app.post('/api/serial', async (req, res) => {
    const { mac, serial } = req.body;

    if (!mac || !serial) {
      return res.status(400).json({ success: false, message: "MAC과 Serial이 필요합니다." });
    }

    try {
			// 1. Device 컬렉션에 매핑 정보 저장 (이미 있으면 업데이트)
			await Device.findOneAndUpdate(
				{ mac_address: mac },
				{ serial: serial },
				{ upsert: true, new: true }
			);

			// 2. 기존 AlarmLog 중 해당 MAC을 가진 모든 로그의 시리얼 넘버 업데이트
			const result = await AlarmLog.updateMany(
				{ mac_address: mac },
				{ $set: { serial: serial } }
			);

			console.log(`✅ Serial Matched: MAC(${mac}) -> Serial(${serial})`);
			res.json({ 
					success: true, 
					message: "매칭 성공 및 기존 로그 업데이트 완료",
					updatedLogs: result.modifiedCount 
			});
    } catch (error) {
        console.error('매칭 에러:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});



// 5. 서버 실행
app.listen(PORT, () => {
	console.log(`🚀 Server running on port ${PORT}`);
});