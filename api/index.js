// index.js
import express from 'express';
import bodyParser from 'body-parser';
import router from './webhook.js'; // Importa el export default de webhook.js

const app = express();

// Middleware para parsear JSON
app.use(bodyParser.json({ limit: '2mb' }));

// Monta el router en la ruta /webhook
app.use('/webhook', router);

// Puerto de escucha
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Bot escuchando en puerto ${port}`);
});
