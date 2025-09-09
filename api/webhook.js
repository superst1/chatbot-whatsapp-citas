import { sendWhatsAppText } from "../lib/whatsapp.js";
import {
  createAppointment,
  updateAppointmentStatusByCedula,
  isHoraDisponible,
  getHorasDisponibles
} from "../lib/sheets.js";
import { callGeminiFlash } from "../lib/geminiFlash.js"; // función que llama a Gemini Flash 1.5

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const conversationState = {};
const slotLocks = new Set();

export default async function handler(req, res) {
  // Verificación webhook
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  if (req.method === "POST") {
    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).json({ received: true });

      const from = msg.from;
      const text = msg.text?.body || "";
      const profileName = req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || "Paciente";

      // Estado actual de la conversación
      const currentState = conversationState[from]?.data || {};

      // Prompt a Gemini Flash 1.5
      const prompt = `
Eres un asistente para agendar o re-agendar citas médicas.
Estado actual: ${JSON.stringify(currentState)}
Mensaje nuevo: "${text}"

Devuélveme un JSON con:
{
  "datos": {
    "nombre_paciente": "...",
    "numero_cedula": "...",
    "fecha_cita": "DD/MM/YYYY",
    "hora_cita": "HH:mm",
    "nombre_contacto": "...",
    "celular_contacto": "..."
  },
  "completo": true/false,
  "respuesta": "Texto natural para el usuario, cordial y claro"
}

Reglas:
- Normaliza fecha a DD/MM/YYYY y hora a HH:mm.
- Si no tienes un dato, deja el valor vacío.
- Si detectas re-agenda, actualiza fecha/hora.
- Si falta algo, en "respuesta" pide solo lo que falta.
`;

      const geminiResp = await callGeminiFlash(prompt);
      let parsed;
      try {
        parsed = JSON.parse(geminiResp);
      } catch {
        await sendWhatsAppText(from, "⚠️ Hubo un problema interpretando la respuesta. Intenta de nuevo.");
        return res.status(200).json({ received: true });
      }

      const { datos, completo, respuesta } = parsed;

      if (completo) {
        // Validar disponibilidad
        const slotKey = `${datos.fecha_cita}|${datos.hora_cita}`;
        if (slotLocks.has(slotKey)) {
          const libres = await getHorasDisponibles(datos.fecha_cita);
          await sendWhatsAppText(from, `⚠️ Ese horario está siendo reservado por otro usuario.\nHoras disponibles: ${libres.join(", ")}`);
          conversationState[from] = { data: datos };
        } else {
          slotLocks.add(slotKey);
          const disponible = await isHoraDisponible(datos.fecha_cita, datos.hora_cita);
          if (!disponible) {
            const libres = await getHorasDisponibles(datos.fecha_cita);
            await sendWhatsAppText(from, `⚠️ La hora ${datos.hora_cita} ya está ocupada el ${datos.fecha_cita}.\nHoras disponibles: ${libres.join(", ")}`);
            conversationState[from] = { data: datos };
          } else {
            const numero_cita = await createAppointment(datos);
            await sendWhatsAppText(from, `✅ ${datos.nombre_paciente}, tu cita para el ${datos.fecha_cita} a las ${datos.hora_cita} ha sido registrada. Nº ${numero_cita}.`);
            delete conversationState[from];
          }
          slotLocks.delete(slotKey);
        }
      } else {
        // Falta información → guardar estado y responder
        conversationState[from] = { data: datos };
        await sendWhatsAppText(from, respuesta);
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      console.error("💥 Webhook error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};
