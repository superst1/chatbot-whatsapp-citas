// lib/geminiFlash.js
import { handleMessage } from "../lib/gemini.js";

/**
 * Llama a Gemini Flash 1.5 con un prompt y devuelve el texto plano.
 * @param {string} prompt - Instrucciones y contexto para Gemini.
 * @returns {Promise<string>} - Respuesta de Gemini.
 */
export async function callGeminiFlash(prompt) {
  try {
    const resp = await handleMessage(prompt);
    // Ajusta según cómo devuelva tu cliente Gemini
    if (typeof resp === "string") return resp;
    if (resp?.text) return resp.text;
    if (resp?.candidates?.[0]?.content?.parts?.[0]?.text) {
      return resp.candidates[0].content.parts[0].text;
    }
    return JSON.stringify(resp);
  } catch (err) {
    console.error("[callGeminiFlash] Error:", err);
    return '{"datos":{},"completo":false,"respuesta":"⚠️ No pude procesar tu solicitud."}';
  }
}
