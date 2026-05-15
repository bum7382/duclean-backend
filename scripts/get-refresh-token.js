// 1회성 스크립트: Google OAuth refresh token 발급
//
// 사전 준비:
// 1) Google Cloud Console에서 OAuth 2.0 클라이언트 ID 생성 (Application type: Desktop app)
// 2) Drive API 사용 설정
// 3) .env에 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 추가
//
// 실행: node scripts/get-refresh-token.js
// → 출력된 URL을 브라우저로 열어 본인 구글 계정으로 동의 → 받은 코드를 터미널에 입력
// → refresh token이 출력되면 .env에 GOOGLE_REFRESH_TOKEN으로 저장

require('dotenv').config();
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
	console.error('❌ .env에 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET를 먼저 설정하세요.');
	process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
	access_type: 'offline',
	prompt: 'consent',
	scope: SCOPES,
});

console.log('\n👉 아래 URL을 브라우저로 열어 동의하세요:\n');
console.log(authUrl);
console.log('\n동의 후 표시되는 코드를 붙여넣고 Enter:');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Code: ', async (code) => {
	rl.close();
	try {
		const { tokens } = await oauth2Client.getToken(code.trim());
		if (!tokens.refresh_token) {
			console.error('\n❌ refresh_token이 비어있음. Google 계정 권한 페이지에서 기존 동의 제거 후 재시도.');
			process.exit(1);
		}
		console.log('\n✅ 발급 성공. 아래 값을 .env에 추가:');
		console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
	} catch (err) {
		console.error('❌ 토큰 교환 실패:', err.message);
		process.exit(1);
	}
});
