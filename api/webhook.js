import { sendWhatsAppText } from "../lib/whatsapp.js";
import {
  createAppointment,
  isHoraDisponible,
  getHorasDisponibles,
  updateAppointmentStatusByCedula,
  updateAppointmentByCedula
} from "../lib/sheets.js";
import { procesarCitaConGemini } from "../lib/gemini.js";

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
      const profileName =
        req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
        "Paciente";

      const currentState = conversationState[from]?.data || {};

      // Procesar con Gemini (versión mejorada que limpia ```json)
      const { datos, completo, respuesta } = await procesarCitaConGemini(
        currentState,
        text
      );

      // === Cancelar cita ===
      if (datos.accion === "cancelar") {
        if (!datos.numero_cedula) {
          conversationState[from] = { data: datos };
          await sendWhatsAppText(from, "Por favor indícame la cédula para cancelar la cita.");
        } else {
          const ok = await updateAppointmentStatusByCedula(datos.numero_cedula, "cancelada");
          if (ok) {
            await sendWhatsAppText(from, `✅ Tu cita con cédula ${datos.numero_cedula} ha sido cancelada.`);
          } else {
            await sendWhatsAppText(from, `⚠️ No encontré una cita con la cédula ${datos.numero_cedula}.`);
          }
          delete conversationState[from];
        }
        return res.status(200).json({ received: true });
      }

      // === Re-agendar cita ===
      if (datos.accion === "reagendar") {
        if (!completo) {
          conversationState[from] = { data: datos };
          await sendWhatsAppText(from, respuesta);
          return res.status(200).json({ received: true });
        }

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
            const ok = await updateAppointmentByCedula(datos.numero_cedula, {
              fecha_cita: datos.fecha_cita,
              hora_cita: datos.hora_cita
            });
            if (ok) {
              await sendWhatsAppText(from, `✅ Tu cita ha sido re-agendada para el ${datos.fecha_cita} a las ${datos.hora_cita}.`);
            } else {
              await sendWhatsAppText(from, `⚠️ No encontré una cita con la cédula ${datos.numero_cedula}.`);
            }
            delete conversationState[from];
          }
          slotLocks.delete(slotKey);
        }
        return res.status(200).json({ received: true });
      }

      // === Crear cita ===
      if (completo) {
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
