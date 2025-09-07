const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

export async function handleMessage(userText) {
  const systemPrompt = `
Eres un parser NLU para citas médicas. Devuelve SOLO JSON válido con:
{
 "intent": "crear_cita|consultar_cita|actualizar_estado|otro",
 "data": {
   "numero_cita": string?,
   "nombre_paciente": string?,
   "numero_cedula": string?,
   "nombre_contacto": string?,
   "celular_contacto": string?,
   "fecha_cita": string?,
   "status_cita": string?,
   "observaciones": string?
 }
}
Ejemplos:
- "crear cita para Juan Pérez mañana 10am, cédula 1234" -> intent crear_cita, extrae nombre_paciente, numero_cedula, fecha_cita
- "consultar 1023" -> intent consultar_cita con numero_cita 1023
- "actualizar 1023 a confirmada" -> intent actualizar_estado con numero_cita 1023 y status_cita confirmada
Si no entiendes, devuelve intent "otro".
`;

  const body = {
    contents: [
      { role: "user", parts: [{ text: systemPrompt + "\nUsuario: " + userText }] }
    ]
  };

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return {
      intent: json.intent || "otro",
      data: json.data || {}
    };
  } catch {
    return { intent: "otro", data: {} };
  }
}
