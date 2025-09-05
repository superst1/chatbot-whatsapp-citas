// ---------------------------------------------------------------- //
// -------------- ASISTENTE DE CITAS MÉDICAS CON GEMINI ------------- //
// ---------------------------------------------------------------- //

// --- PASO 1: IMPORTAR HERRAMIENTAS ---
const express = require('express');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- PASO 2: CONFIGURAR DATOS SENSIBLES (DESDE VERCEL) ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

// --- PASO 3: INICIALIZAR SERVICIOS ---
const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const serviceAccountAuth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// --- PASO 4: LÓGICA DEL WEBHOOK ---

// Parte 1: Verificación para Meta y prueba manual (usa el método GET)
app.get('/', (req, res) => {
    // Si Meta envía su solicitud de verificación, respóndele.
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        console.log("Verificación del webhook exitosa!");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        // Si eres tú visitando la URL en el navegador, te saluda.
        console.log("Recibida una solicitud GET, pero no es de Meta. Saludando.");
        res.status(200).send('¡Hola! El webhook está activo y esperando mensajes de WhatsApp. Configura esta URL en la plataforma de Meta.');
    }
});

// Parte 2: Recibir mensajes de WhatsApp (usa el método POST)
app.post('/', async (req, res) => {
    const messageData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (messageData && messageData.type === 'text') {
        const from = messageData.from;
        const text = messageData.text.body;
        console.log(`Mensaje recibido de ${from}: "${text}"`);
        try {
            const prompt = `
                Eres un asistente virtual para agendar citas médicas. Analiza el siguiente mensaje de un paciente: "${text}".
                Tu tarea es extraer la siguiente información en formato JSON. Si una información no está presente, déjala como "pendiente".
                - nombre_paciente
                - numero_cedula
                - fecha_cita
                - accion: (agendar, reagendar o consultar)
                - observaciones
                Responde ÚNICAMENTE con el objeto JSON.`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const jsonText = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            const data = JSON.parse(jsonText);

            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            const newRow = {
                numero_cita: `CITA-${Date.now()}`,
                nombre_paciente: data.nombre_paciente || 'pendiente',
                numero_cedula: data.numero_cedula || 'pendiente',
                nombre_contacto: 'pendiente',
                celular_contacto: from,
                fecha_cita: data.fecha_cita || 'pendiente',
                status_cita: 'solicitada',
                observaciones: data.observaciones || '',
                timestamp: new Date().toISOString()
            };
            await sheet.addRow(newRow);

            let replyText = `¡Recibido! Hemos registrado tu solicitud para ${data.accion || 'una cita'} a nombre de ${data.nombre_paciente || 'un paciente'}. Pronto un asesor confirmará los detalles.`;
            await sendWhatsAppMessage(from, replyText);

        } catch (error) {
            console.error('Error procesando el mensaje:', error);
            await sendWhatsAppMessage(from, 'Lo siento, tuve un problema para procesar tu solicitud. Por favor, intenta de nuevo.');
        }
    }
    res.sendStatus(200);
});

// --- FUNCIÓN PARA ENVIAR MENSAJES ---
async function sendWhatsAppMessage(to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', to: to, text: { body: text } },
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        console.log(`Mensaje de respuesta enviado a ${to}`);
    } catch (error) {
        console.error('Error enviando mensaje de WhatsApp:', error.response?.data);
    }
}

// --- PASO FINAL PARA VERCEL ---
module.exports = app;
