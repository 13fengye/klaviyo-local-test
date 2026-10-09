import 'dotenv/config';
import express from 'express';
import handler from './handler.js';

const app = express();

// 必须加这两行，否则 req.body 会是 undefined
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/api/events', async (req, res) => {
    try {
        await handler(req, res);
    } catch (err) {
        console.error('Unhandled Server Error:', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));