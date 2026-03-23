const mysql = require('mysql2');
require('dotenv').config();

// Sử dụng Pool để tiết kiệm RAM trên hosting [cite: 85]
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'fta_crm_db',
    waitForConnections: true,
    connectionLimit: 10, // Giới hạn kết nối để không treo RAM [cite: 85]
    queueLimit: 0
});

module.exports = pool.promise();