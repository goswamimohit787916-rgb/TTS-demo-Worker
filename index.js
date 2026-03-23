export default {
  async fetch(request, env) {
    const { DB, R2, LIGHTNING_KEYS, LIGHTNING_ENDPOINT } = env;

    // 1. CORS Setup
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      const formData = await request.formData();
      const userId = formData.get("user_id"); // Passed from frontend login
      const text = formData.get("text");
      const action = formData.get("action"); // 'generate' or 'clone'

      // 2. AUTH & CREDIT CHECK (D1)
      const user = await DB.prepare("SELECT credits FROM users WHERE id = ?")
        .bind(userId).first();
      
      if (!user || user.credits <= 0) {
        return new Response(JSON.stringify({ error: "No credits left" }), { status: 403, headers: corsHeaders });
      }

      // 3. API KEY ROTATION (The Switcher)
      const keys = LIGHTNING_KEYS.split(',');
      const randomKey = keys[Math.floor(Math.random() * keys.length)];

      // 4. VOICE CLONING LOGIC (.pth / reference audio)
      let voiceRefUrl = "";
      if (action === "clone") {
        const file = formData.get("voice_file"); // .wav or .pth
        const fileKey = `clones/${userId}/${Date.now()}.wav`;
        
        // Store in R2 so Lightning AI can fetch it
        await R2.put(fileKey, file);
        voiceRefUrl = `https://your-r2-public-worker-url.com/${fileKey}`;

        // Bind data in D1
        await DB.prepare("INSERT INTO voices (id, user_id, r2_path) VALUES (?, ?, ?)")
          .bind(crypto.randomUUID(), userId, fileKey).run();
      }

      // 5. CALL LIGHTNING AI
      const response = await fetch(LIGHTNING_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${randomKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: text,
          reference_audio: voiceRefUrl,
          model: "qwen3-tts-1.7b"
        })
      });

      if (!response.ok) throw new Error("Lightning AI Error");

      // 6. DEDUCT CREDIT (D1)
      await DB.prepare("UPDATE users SET credits = credits - 1 WHERE id = ?")
        .bind(userId).run();

      // Return the audio stream
      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "audio/mpeg" }
      });

    } catch (err) {
      return new Response(err.message, { status: 500, headers: corsHeaders });
    }
  }
}
