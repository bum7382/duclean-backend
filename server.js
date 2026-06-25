require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const mqtt = require('mqtt');
const { startDailyBackupCron, logsToCsv, getDriveClient } = require('./backup');

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

// MAC -> 마지막으로 본 (flag, code) — 알람 상태 변경 시에만 로그 찍기 위함
const lastAlarmState = new Map();

// MQTT payload 파싱:
//   "YYYY-MM-DD HH:MM:SS MAC IP [reg0, reg1, ..., reg68]"
// → { date, time, mac, ip, registers: number[] }
function parseMqttPayload(payload) {
	const arrayStart = payload.indexOf('[');
	if (arrayStart === -1) return null;
	const header = payload.slice(0, arrayStart).trim().split(/\s+/);
	if (header.length < 4) return null;
	let registers;
	try {
		registers = JSON.parse(payload.slice(arrayStart));
	} catch (_) {
		return null;
	}
	if (!Array.isArray(registers)) return null;
	return {
		date: header[0],
		time: header[1],
		mac: header[2],
		ip: header[3],
		registers,
	};
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

		const parsed = parseMqttPayload(payload);
		if (!parsed) {
			console.error(`❌ MQTT Message Error: parse failed. Received: [${payload}]`);
			return;
		}

		const { date: date_part, time: time_part, mac: mac_address, ip: ip_address, registers } = parsed;

		// 새 포맷은 reg 0~68(69개). 짧은 배열은 옛날/미업데이트 펌웨어 → 스킵
		if (registers.length < 26) {
			console.warn(`⚠️ Skipping legacy/short payload from MAC=${mac_address} (registers.length=${registers.length})`);
			return;
		}

		const flag = registers[24];  // 알람부저 플래그 (1:발생, 0:해제)
		const code = registers[25];  // 알람발생코드 (0~7)

		// 시각 생성 및 변환 (KST)
		const real_timestamp_string = `${date_part}T${time_part}+09:00`;
		const real_timestamp = new Date(real_timestamp_string);

		// 차압/CT1/CT2 캐시 갱신
		latestRegisterCache.set(mac_address, {
			pressure: registers[0],          // mmAq, scale 1
			current1: registers[1] / 10,     // A, scale 0.1
			current2: registers[2] / 10,     // A, scale 0.1
			ip_address,
			receivedAt: real_timestamp,
		});

		// 알람 상태 변경 시에만 로그 출력
		const prev = lastAlarmState.get(mac_address);
		if (!prev || prev.flag !== flag || prev.code !== code) {
			console.log(`[MQTT] Alarm state changed: MAC=${mac_address}, Flag=${flag}, Code=${code}`);
			lastAlarmState.set(mac_address, { flag, code });
		}

		try {
			// DB에서 해당 MAC 주소에 매핑된 시리얼 넘버가 있는지 확인
			const deviceMatch = await Device.findOne({ mac_address: mac_address });
			const currentSerial = deviceMatch ? deviceMatch.serial : null;

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
					// 원자적 upsert: 같은 (MAC, status, active=true) 있으면 no-op, 없으면 INSERT
					// (findOne + save 분리 시 race condition으로 중복 INSERT 발생 가능)
					const result = await AlarmLog.findOneAndUpdate(
						{ mac_address: mac_address, status: code, active: true },
						{
							$setOnInsert: {
								timestamp: real_timestamp,
								mac_address: mac_address,
								ip_address: ip_address,
								status: code,
								active: true,
								serial: currentSerial,
							},
						},
						{ upsert: true, new: false, setDefaultsOnInsert: true }
					);
					if (!result) {
						// new: false + upsert → 새로 INSERT된 경우 null 반환
						console.log('💾 New Alarm log saved to MongoDB (Active: true).');
					}
			}
			// flag=1 && code=0 (정상 상태 체크)는 로그 없이 무시

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

// [GET] /api/metrics: 시계열 센서 로그 조회 (mac 필수, 기간 필터 가능)
app.get('/api/metrics', async (req, res) => {
	const { mac, from, to } = req.query;
	const limit = Math.min(Math.max(parseInt(req.query.limit) || 1000, 1), 10000);

	if (!mac) {
		return res.status(400).json({ success: false, message: "mac 쿼리 파라미터가 필요합니다." });
	}

	const query = { 'metadata.mac': mac };
	if (from || to) {
		query.timestamp = {};
		if (from) query.timestamp.$gte = new Date(from);
		if (to) query.timestamp.$lte = new Date(to);
	}

	try {
		const logs = await Log.find(query)
			.sort({ timestamp: 1 })
			.limit(limit)
			.select('timestamp pressure current1 current2 -_id')
			.lean();

		res.json({ data: logs });
	} catch (error) {
		console.error('메트릭 조회 에러:', error);
		res.status(500).json({ success: false, message: error.message });
	}
});

// [GET] /api/metrics/export: 시계열 센서 로그 CSV 다운로드
app.get('/api/metrics/export', async (req, res) => {
	const { mac, from, to } = req.query;

	if (!mac) {
		return res.status(400).json({ success: false, message: "mac 쿼리 파라미터가 필요합니다." });
	}

	const query = { 'metadata.mac': mac };
	if (from || to) {
		query.timestamp = {};
		if (from) query.timestamp.$gte = new Date(from);
		if (to) query.timestamp.$lte = new Date(to);
	}

	try {
		const logs = await Log.find(query)
			.sort({ timestamp: 1 })
			.lean();

		const csv = logsToCsv(logs);
		const fromLabel = from ? new Date(from).toISOString().slice(0, 10) : 'all';
		const toLabel = to ? new Date(to).toISOString().slice(0, 10) : 'all';
		const fileName = `duclean_${mac.replace(/:/g, '')}_${fromLabel}_${toLabel}.csv`;

		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
		// UTF-8 BOM (Excel 호환)
		res.write('﻿');
		res.end(csv);
	} catch (error) {
		console.error('메트릭 export 에러:', error);
		res.status(500).json({ success: false, message: error.message });
	}
});

// [GET] /api/backups: Google Drive 백업 CSV 목록
app.get('/api/backups', async (req, res) => {
	try {
		const drive = getDriveClient();
		const result = await drive.files.list({
			q: "name contains 'duclean_logs_' and mimeType='text/csv' and trashed=false",
			fields: 'files(id, name, size, createdTime)',
			orderBy: 'name desc',
			pageSize: 200,
		});
		res.json({ data: result.data.files || [] });
	} catch (error) {
		console.error('백업 목록 조회 에러:', error.message);
		res.status(500).json({ success: false, message: error.message });
	}
});

// [GET] /api/backups/:id/download: Drive 파일 프록시 다운로드
app.get('/api/backups/:id/download', async (req, res) => {
	const { id } = req.params;
	try {
		const drive = getDriveClient();
		const meta = await drive.files.get({ fileId: id, fields: 'name' });
		const stream = await drive.files.get(
			{ fileId: id, alt: 'media' },
			{ responseType: 'stream' }
		);

		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', `attachment; filename="${meta.data.name}"`);
		stream.data.on('error', (err) => {
			console.error('Drive stream error:', err.message);
			if (!res.headersSent) res.status(500).end();
		}).pipe(res);
	} catch (error) {
		console.error('백업 다운로드 에러:', error.message);
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