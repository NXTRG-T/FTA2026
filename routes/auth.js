const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Giao diện đăng nhập
router.get('/login', (req, res) => {
    res.render('login', { error: null }); // Bạn cần tạo file views/login.ejs
});
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [users] = await db.execute('SELECT * FROM Users WHERE username = ?', [username]);
        
        if (users.length > 0) {
            const user = users[0];
            
            // So sánh mật khẩu (Đang dùng plaintext tạm theo Note trước, nếu dùng bcrypt thì so sánh bcrypt)
            if (password === user.password) {
                
                // KIỂM TRA KHÓA TÀI KHOẢN 
                if (user.role === 'Staff' && user.is_locked === 1) {
                    // Nếu bị khóa, trả về giao diện đăng nhập kèm dòng thông báo của Admin
                    return res.render('login', { 
                        error: `Tài khoản của bạn đã bị khóa. Lời nhắn từ Admin: "${user.lock_message || 'Không có lý do'}"` 
                    });
                }

                // Nếu hợp lệ, lưu session và vào Dashboard/Staff Page
                req.session.userId = user.id;
                req.session.role = user.role;
                req.session.username = user.username;
                
                if (user.role === 'Admin') return res.redirect('/admin/dashboard');
                return res.redirect('/staff');
            }
        }
        res.render('login', { error: 'Sai tài khoản hoặc mật khẩu. Vui lòng liên hệ Admin hoặc gửi email tới: it@bricsvn.com' });
    } catch (err) {
        console.error('Lỗi chi tiết khi đăng nhập:', err);
        res.status(500).send('Lỗi kết nối cơ sở dữ liệu: ' + err.message);
    }
});

// Đăng xuất
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/auth/login');
});

module.exports = router;