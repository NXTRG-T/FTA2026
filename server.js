const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config();
const db = require('./config/db');

const app = express();

app.use(express.static('public'));

// 0. Hàm format thời gian chuẩn (dd/mm/yyyy hh:mm:ss) dùng chung cho mọi file EJS
app.locals.formatDateTime = function(dateString) {
    if (!dateString) return '';
    const d = new Date(dateString);
    const pad = (n) => n < 10 ? '0' + n : n; // Thêm số 0 đằng trước nếu nhỏ hơn 10
    
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
};

// 1. Cấu hình Middleware
app.use(express.urlencoded({ extended: true })); // Xử lý dữ liệu từ Form (Tiếng Việt mượt mà) [cite: 17]
app.use(express.json()); // Xử lý dữ liệu JSON
app.use(express.static(path.join(__dirname, 'public'))); // Phục vụ file tĩnh (CSS, JS) [cite: 86]
app.set('view engine', 'ejs'); // Sử dụng EJS để render phía server [cite: 92]

// 2. Cấu hình Session (Tối ưu cho RAM 1GB) [cite: 107]
app.use(session({
    secret: process.env.SESSION_SECRET || 'fta_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24, // Session tồn tại 24h
        secure: false 
    }
}));

// 3. Import Routes [cite: 88]
app.use('/auth', require('./routes/auth'));
app.use('/staff', require('./routes/staff'));
app.use('/admin', require('./routes/admin'));
app.use('/checkin', require('./routes/checkin')); // Thêm module Check-in công khai

// 4. Điều hướng trang chủ (Landing Page) hoặc Dashboard dựa trên Role
app.get('/', (req, res) => {
    // Nếu người dùng đã đăng nhập rồi thì cho họ vào Dashboard luôn, đừng bắt xem Landing Page nữa
    if (req.session.userId) {
        if (req.session.role === 'Admin') return res.redirect('/admin/dashboard');
        return res.redirect('/staff');
    }
    
    // Nếu chưa đăng nhập thì hiện Landing Page
    res.render('index');
});

// 5. Middleware xử lý lỗi 404 (PHẢI NẰM CUỐI CÙNG) 
// Nếu không có route nào ở trên khớp, lệnh này sẽ chạy
app.use((req, res) => {
    res.status(404).send('Không tìm thấy trang này. Vui lòng kiểm tra lại đường dẫn!');
});

// 5.5. Khởi tạo cấu hình hệ thống toàn cục (Global Variables cho EJS)
async function loadSystemConfigs() {
    try {
        const [rows] = await db.execute('SELECT config_key, config_value FROM System_Configs');
        rows.forEach(row => {
            app.locals[row.config_key] = row.config_value;
        });
        console.log('✅ Đã tải cấu hình hệ thống (Logo, Banner...)');
    } catch (error) {
        console.error('❌ Lỗi tải cấu hình hệ thống:', error);
    }
}
loadSystemConfigs();

// ==========================================
// HỆ THỐNG REAL-TIME SSE & NHẮC VIỆC (REMINDER)
// ==========================================
global.sseClients = [];

app.get('/stream/notifications', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    
    // ĐỊNH DANH NHÂN VIÊN: Gắn userId vào kết nối
    res.userId = req.session.userId; 
    global.sseClients.push(res);

    req.on('close', () => {
        global.sseClients = global.sseClients.filter(client => client !== res);
    });
});

global.sendRealtimeNotification = () => {
    global.sseClients.forEach(client => client.write(`data: ${JSON.stringify({ type: 'NEW_NOTIFICATION' })}\n\n`));
};

// CRON-JOB SIÊU NHẸ: Quét lịch hẹn mỗi phút 1 lần
setInterval(async () => {
    try {
        const db = require('./config/db'); // Đảm bảo import db
        // Tìm khách hàng có lịch hẹn gọi lại trong khoảng từ (Hiện tại - 1 phút) đến (Hiện tại + 1 phút)
        const [reminders] = await db.execute(`
            SELECT id, full_name, staff_id 
            FROM Customers 
            WHERE next_call_date >= DATE_SUB(NOW(), INTERVAL 1 MINUTE) 
              AND next_call_date <= DATE_ADD(NOW(), INTERVAL 1 MINUTE) 
              AND is_deleted = 0
        `);

        reminders.forEach(cust => {
            // Chỉ bắn thông báo cho đúng nhân viên phụ trách khách đó
            global.sseClients.forEach(client => {
                if (client.userId === cust.staff_id) {
                    client.write(`data: ${JSON.stringify({ 
                        type: 'REMINDER', 
                        message: `Đã đến giờ gọi lại cho khách hàng: ${cust.full_name}!` 
                    })}\n\n`);
                }
            });
        });
    } catch (err) { console.error("Lỗi quét Reminder:", err); }
}, 60000); // 60000ms = 1 phút

// 6. Kích hoạt Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Hệ thống CRM chạy tại: http://localhost:${PORT}`);
});