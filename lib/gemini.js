// lib/gemini.js
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

/**
 * Llama a Gemini Flash 1.5 con un prompt y devuelve el texto de respuesta.
 * @param {string} prompt - Instrucciones y contexto para Gemini.
 * @returns {Promise<string>} - Texto devuelto por Gemini.
 */
export async function handleMessage(prompt) {
  try {
    const resp = await fetch(`${MODEL_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      })
    });

    if (!resp.ok) {
      throw new Error(`Error HTTP ${resp.status}`);
    }

    const data = await resp.json();

    // Gemini devuelve texto en esta ruta normalmente
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      data?.candidates?.[0]?.output ||
      "";

    return text.trim();
  } catch (err) {
    console.error("[handleMessage] Error:", err);
    return "";
  }
}

/**
 * Genera el prompt para agenda/re-agenda de citas médicas y llama a Gemini.
 * @param {object} estadoActual - Datos ya capturados de la cita.
 * @param {string} mensajeUsuario - Texto nuevo del usuario.
 * @returns {Promise<object>} - Objeto { datos, completo, respuesta }
 */
export async function procesarCitaConGemini(estadoActual, mensajeUsuario) {
  const prompt = `
Eres un asistente para agendar o re-agendar citas médicas.
Estado actual de la cita: ${JSON.stringify(estadoActual || {})}
Mensaje nuevo del usuario: "${mensajeUsuario}"

Devuélveme SOLO un JSON válido con:
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
- No incluyas texto fuera del JSON.
`;

  const raw = await handleMessage(prompt);

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[procesarCitaConGemini] Error parseando JSON:", err, "Respuesta cruda:", raw);
    return {
      datos: {},
      completo: false,
      respuesta: "⚠️ No pude interpretar tu solicitud, ¿puedes repetirla?"
    };
  }
}
