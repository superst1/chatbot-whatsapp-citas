// lib/whatsapp.js
import fetch from "node-fetch";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Token de acceso de la app de WhatsApp
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // ID del número de teléfono de WhatsApp Business

/**
 * Envía un mensaje de texto por WhatsApp usando la API de Meta.
 * @param {string} to - Número de destino en formato internacional (sin +).
 * @param {string} message - Texto del mensaje.
 * @returns {Promise<object>} - Respuesta de la API de WhatsApp.
 */
export async function sendWhatsAppText(to, message) {
  try {
    const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("[sendWhatsAppText] Error:", errorText);
      throw new Error(`Error enviando mensaje a WhatsApp: ${resp.status}`);
    }

    const data = await resp.json();
    console.log("[sendWhatsAppText] Mensaje enviado:", data);
    return data;
  } catch (err) {
    console.error("[sendWhatsAppText] Excepción:", err);
    throw err;
  }
}
