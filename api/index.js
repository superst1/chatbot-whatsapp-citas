// index.js (versión moderna)
import express from 'express';
// Ya no necesitas importar 'body-parser'
import router from './routes/webhook.js'; // Verifiqué que la ruta a tu archivo webhook sea correcta

const app = express();

// Middleware para parsear JSON (usando la función integrada de Express)
app.use(express.json({ limit: '2mb' }));

// Monta el router en la ruta /webhook
app.use('/webhook', router);

// Puerto de escucha
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Bot escuchando en puerto ${port}`);
});
