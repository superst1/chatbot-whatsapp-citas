import express from 'express';
import bodyParser from 'body-parser';
import router from './webhook.js';

const app = express();
console.log('Router importado:', router);
app.use(bodyParser.json({ limit: '2mb' }));

app.use('/webhook', router);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Bot escuchando en puerto ${port}`);
});
