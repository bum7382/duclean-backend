require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors());
app.use(express.json());

// 1. MongoDB 연결
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 2. 스키마 정의
const AlarmSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  alarm: { type: String, required: true }
});

const AlarmLog = mongoose.model('AlarmLog', AlarmSchema, 'alarm');

// ---------------------------------------------------------
// API 라우트
// ---------------------------------------------------------

// [GET] 'alarm' 컬렉션의 전체 데이터 조회
app.get('/api/logs', async (req, res) => {
  try {
    // timestamp 내림차순(최신순) 정렬
    const logs = await AlarmLog.find()
      .sort({ timestamp: -1 })
      .select('alarm -_id');

    console.log(`[GET] 조회된 데이터: ${logs.length}건`); // 서버 콘솔 확인용

    res.json({
      data: logs
    });
  } catch (error) {
    console.error('조회 에러:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 서버 실행
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});