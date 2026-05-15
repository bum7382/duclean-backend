const { google } = require('googleapis');
const { Readable } = require('stream');
const cron = require('node-cron');

const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getDriveClient() {
	const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
	if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
		throw new Error('Google OAuth env vars missing (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
	}
	const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
	auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN, scope: SCOPES.join(' ') });
	return google.drive({ version: 'v3', auth });
}

// KST 기준 어제 00:00 ~ 오늘 00:00 [start, end) 범위와 YYYY-MM-DD 라벨
function yesterdayKstRange(now = new Date()) {
	const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
	const kstNowMs = now.getTime() + KST_OFFSET_MS;
	const kstTodayMidnightMs = Math.floor(kstNowMs / 86400000) * 86400000;
	const startMs = kstTodayMidnightMs - 86400000 - KST_OFFSET_MS;
	const endMs = kstTodayMidnightMs - KST_OFFSET_MS;
	const start = new Date(startMs);
	const end = new Date(endMs);
	const label = new Date(kstTodayMidnightMs - 86400000).toISOString().slice(0, 10);
	return { start, end, label };
}

function escapeCsv(value) {
	if (value === null || value === undefined) return '';
	const s = String(value);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function logsToCsv(logs) {
	const header = 'timestamp_KST,mac,serial,pressure_mmAq,current1_A,current2_A';
	const rows = logs.map(log => {
		const tsKst = new Date(log.timestamp.getTime() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
		return [
			tsKst,
			escapeCsv(log.metadata?.mac),
			escapeCsv(log.metadata?.serial),
			escapeCsv(log.pressure),
			escapeCsv(log.current1),
			escapeCsv(log.current2),
		].join(',');
	});
	return [header, ...rows].join('\n') + '\n';
}

async function backupYesterday(Log) {
	const { start, end, label } = yesterdayKstRange();
	const logs = await Log.find({ timestamp: { $gte: start, $lt: end } })
		.sort({ timestamp: 1 })
		.lean();

	if (logs.length === 0) {
		console.log(`ℹ️ Drive backup: no logs for ${label}, skip upload.`);
		return;
	}

	const csv = logsToCsv(logs);
	const drive = getDriveClient();
	const fileName = `duclean_logs_${label}.csv`;

	const res = await drive.files.create({
		requestBody: { name: fileName, mimeType: 'text/csv' },
		media: { mimeType: 'text/csv', body: Readable.from(csv) },
		fields: 'id, name',
	});
	console.log(`✅ Drive backup uploaded: ${res.data.name} (id=${res.data.id}, rows=${logs.length})`);
}

function startDailyBackupCron(Log) {
	if (!process.env.GOOGLE_REFRESH_TOKEN) {
		console.warn('⚠️ GOOGLE_REFRESH_TOKEN not set — daily Drive backup disabled.');
		return;
	}
	// 매일 KST 00:30 — TTL 30일 안전 마진 충분
	cron.schedule('30 0 * * *', () => {
		backupYesterday(Log).catch(err => console.error('❌ Drive backup failed:', err.message));
	}, { timezone: 'Asia/Seoul' });
	console.log('🗓️  Daily Drive backup cron scheduled (KST 00:30)');
}

module.exports = { startDailyBackupCron, backupYesterday };
