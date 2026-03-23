import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors({ origin: '*' }));

const REPLICATE_VERSION = "qwen/qwen3-tts"; // Official model on Replicate

// Simple auth middleware (demo only - upgrade to proper JWT in production)
async function getUser(c: any) {
  const email = c.req.header('x-user-email') || 'demo@qwen3.com'; // Replace with real auth later
  const user = await c.env.DB.prepare(
    "SELECT id, credits FROM users WHERE email = ?"
  ).bind(email).first();
  return user;
}

// ====================== GENERATE TTS ======================
app.post('/api/generate', async (c) => {
  const { text, voice_id, language = "en" } = await c.req.json();

  if (!text || text.length > 2500) {
    return c.json({ success: false, error: "Invalid text" }, 400);
  }

  const user = await getUser(c);
  if (!user) return c.json({ success: false, error: "User not found" }, 401);
  if (user.credits < 10) {
    return c.json({ success: false, error: "Not enough credits" }, 402);
  }

  let input: any = {
    text: text,
    language: language,
    model_size: "1.7B"   // or "0.6B" for faster
  };

  // Add voice cloning reference if selected
  if (voice_id) {
    const voice = await c.env.DB.prepare(
      "SELECT reference_audio_base64 FROM cloned_voices WHERE id = ? AND user_id = ?"
    ).bind(voice_id, user.id).first();

    if (voice) {
      input.reference_audio = voice.reference_audio_base64; // Base64 data URL or raw base64
    }
  }

  // Call Replicate (real Qwen3-TTS inference on external GPU)
  const replicateRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${c.env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: "latest", // or specific version from Replicate page
      input: input,
    }),
  });

  let prediction = await replicateRes.json();

  // In production, use webhooks or polling. For simplicity we assume sync or quick response.
  // If Replicate returns output directly:
  const audioUrl = prediction.output || prediction.urls?.get; 

  if (!audioUrl) {
    return c.json({ success: false, error: "Generation failed" }, 500);
  }

  // Deduct credits
  await c.env.DB.prepare(
    "UPDATE users SET credits = credits - 10 WHERE id = ?"
  ).bind(user.id).run();

  // Save generation
  await c.env.DB.prepare(
    "INSERT INTO generations (user_id, text, audio_url, voice_id, credits_used) VALUES (?, ?, ?, ?, 10)"
  ).bind(user.id, text, audioUrl, voice_id || null).run();

  return c.json({
    success: true,
    audio_url: audioUrl,
    remaining_credits: user.credits - 10
  });
});

// ====================== CLONE VOICE ======================
app.post('/api/clone', async (c) => {
  const { name, audio_base64 } = await c.req.json(); // audio_base64 should be short (\~3s)
  const user = await getUser(c);

  if (!user || !name || !audio_base64) {
    return c.json({ success: false, error: "Missing data" }, 400);
  }

  const result = await c.env.DB.prepare(
    "INSERT INTO cloned_voices (user_id, name, reference_audio_base64) VALUES (?, ?, ?)"
  ).bind(user.id, name, audio_base64).run();

  return c.json({
    success: true,
    voice_id: result.meta.last_row_id,
    message: "Voice cloned! Use it in Generate."
  });
});

// ====================== GET USER VOICES ======================
app.get('/api/voices', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ voices: [] });

  const voices = await c.env.DB.prepare(
    "SELECT id, name FROM cloned_voices WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(user.id).all();

  return c.json({ voices: voices.results || [] });
});

// ====================== BASIC LOGIN (demo) ======================
app.post('/api/login', async (c) => {
  const { email, password } = await c.req.json();
  const user = await c.env.DB.prepare(
    "SELECT id, email, credits FROM users WHERE email = ? AND password_hash = ?"
  ).bind(email, password + "_hash").first(); // Replace with real bcrypt

  if (user) {
    return c.json({ success: true, email: user.email, credits: user.credits });
  }
  return c.json({ success: false, error: "Invalid credentials" }, 401);
});

export default app;
