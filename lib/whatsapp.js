import fetch from 'node-fetch'; // Si no usas Cloud API, adapta a tu transporte actual.

const WHATSAPP_BEARER = process.env.WHATSAPP_BEARER;

export async function sendText(to, body) {
  // Reemplaza por tu implementación actual si no usas Cloud API.
  if (!WHATSAPP_BEARER) {
    console.log('[WHATSAPP OUT]', to, body);
    return;
  }
  // Ejemplo para WhatsApp Cloud API:
  const phoneNumberId = process.env.WHATSAPP_PHONE_ID;
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_BEARER}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}
