import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========= CONFIG: API KEY + BASE URL =========

const API_KEY =
  process.env.GOOGLE_AI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GEMINI_API_KEY;

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

if (!API_KEY) {
  console.error(
    '❌ No Gemini API key found. Set GOOGLE_AI_API_KEY or GOOGLE_API_KEY or GEMINI_API_KEY in Render.'
  );
}

// ========= CORS CONFIG =========

const allowedOrigins = [
  'https://atmospheres.digicomm.online', // your frontend
  'http://localhost:3000',               // local testing
];

app.use(
  cors({
    origin(origin, callback) {
      // Allow tools without Origin (curl, Postman, etc.)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Explicitly handle preflight
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// ========= IN-MEMORY OPERATION STORE =========

/**
 * operations Map structure:
 * {
 *   [operationId]: {
 *     id,
 *     status: 'processing' | 'completed',
 *     visualPrompt,
 *     audioPrompt,
 *     duration,
 *     aspectRatio,
 *     createdAt,
 *     completedAt?,
 *     remoteName,   // long-running operation name from Google
 *     videoUrl?,    // final video URI
 *     metadata?
 *   }
 * }
 */
const operations = new Map();

function makeOperationId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ========= ROUTES =========

// Root health/info
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    message: 'Veo 3.1 Backend API Server',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /api/health',
      generate: 'POST /api/generate',
      status: 'GET /api/status/:id',
    },
  });
});

// API health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: !!API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ========= GENERATE VIDEO (TEXT → VIDEO) =========

app.post('/api/generate', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: 'Google AI not configured',
        message: 'Missing API key (GOOGLE_AI_API_KEY / GOOGLE_API_KEY / GEMINI_API_KEY)',
      });
    }

    const {
      visualPrompt,
      audioPrompt,
      duration = '10 seconds',
      aspectRatio = '16:9',
    } = req.body;

    if (!visualPrompt) {
      return res.status(400).json({ error: 'Missing required field: visualPrompt' });
    }

    console.log(`🎬 Generating video for prompt: "${visualPrompt.substring(0, 60)}..."`);

    // Combine visual + audio descriptions into one prompt for now
    const combinedPrompt = audioPrompt
      ? `${visualPrompt}\n\nAudio description: ${audioPrompt}`
      : visualPrompt;

    // Map duration string → numeric seconds (approximate)
    const durationMap = {
      '5 seconds': 5,
      '10 seconds': 10,
      '20 seconds': 20,
      '30 seconds': 30,
    };
    const durationSeconds = durationMap[duration] || 10;

    // Call Veo long-running endpoint (REST) per docs:
    // POST /models/veo-3.1-generate-preview:predictLongRunning
    const resp = await fetch(
      `${BASE_URL}/models/veo-3.1-generate-preview:predictLongRunning`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY,
        },
        body: JSON.stringify({
          instances: [
            {
              prompt: combinedPrompt,
              // Optional: you can experiment with these later:
              // "aspectRatio": aspectRatio,
              // "durationSeconds": durationSeconds,
            },
          ],
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error('❌ Veo generation HTTP error:', resp.status, text);
      return res.status(500).json({
        error: 'Generation failed',
        message: `Veo HTTP ${resp.status}: ${text}`,
      });
    }

    const data = await resp.json();
    const remoteName = data.name; // long-running operation name

    if (!remoteName) {
      console.error('❌ Veo response missing operation name:', data);
      return res.status(500).json({
        error: 'Generation failed',
        message: 'Veo response missing operation name',
      });
    }

    const operationId = makeOperationId();

    // Store operation
    operations.set(operationId, {
      id: operationId,
      status: 'processing',
      visualPrompt,
      audioPrompt,
      duration,
      aspectRatio,
      createdAt: Date.now(),
      remoteName,
      videoUrl: null,
      metadata: null,
    });

    // Kick off background polling
    monitorOperation(operationId).catch((err) =>
      console.error('Background monitor error:', err)
    );

    res.json({
      success: true,
      operationId,
      message: 'Video generation started',
      estimatedTime: '60–90 seconds',
    });
  } catch (error) {
    console.error('❌ Generation error:', error);
    res.status(500).json({
      error: 'Generation failed',
      message: error.message,
    });
  }
});

// ========= STATUS CHECK =========

app.get('/api/status/:id', async (req, res) => {
  try {
    const operationId = req.params.id;
    const stored = operations.get(operationId);

    if (!stored) {
      return res.status(404).json({
        error: 'Operation not found',
        operationId,
      });
    }

    // If already completed, return cached result
    if (stored.status === 'completed' && stored.videoUrl) {
      return res.json({
        success: true,
        status: 'completed',
        operationId,
        videoUrl: stored.videoUrl,
        metadata: stored.metadata,
      });
    }

    // Otherwise, refresh from Google
    const status = await fetch(`${BASE_URL}/${stored.remoteName}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': API_KEY },
    });

    if (!status.ok) {
      const text = await status.text();
      console.error('❌ Status HTTP error:', status.status, text);
      return res.status(500).json({
        error: 'Status check failed',
        message: `Veo status HTTP ${status.status}: ${text}`,
      });
    }

    const json = await status.json();

    if (json.done) {
      const videoUri =
        json.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        null;

      stored.status = 'completed';
      stored.videoUrl = videoUri;
      stored.metadata = json.response;
      stored.completedAt = Date.now();

      return res.json({
        success: true,
        status: 'completed',
        operationId,
        videoUrl: videoUri,
        metadata: json.response,
      });
    }

    // Still processing
    return res.json({
      success: true,
      status: 'processing',
      operationId,
      message: 'Video is still generating...',
    });
  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({
      error: 'Status check failed',
      message: error.message,
    });
  }
});

// ========= BACKGROUND MONITOR =========

async function monitorOperation(operationId) {
  const maxAttempts = 120; // ~2 minutes if every second
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;

    const stored = operations.get(operationId);
    if (!stored) {
      clearInterval(interval);
      return;
    }

    if (stored.status === 'completed') {
      clearInterval(interval);
      return;
    }

    try {
      const resp = await fetch(`${BASE_URL}/${stored.remoteName}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': API_KEY },
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(
          `❌ Monitoring HTTP error for ${operationId}:`,
          resp.status,
          text
        );
        return;
      }

      const json = await resp.json();

      if (json.done) {
        const videoUri =
          json.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
          null;

        operations.set(operationId, {
          ...stored,
          status: 'completed',
          videoUrl: videoUri,
          metadata: json.response,
          completedAt: Date.now(),
        });

        console.log(`✅ Video ready: ${operationId}`);
        clearInterval(interval);
      }
    } catch (err) {
      console.error(`❌ Monitoring error for ${operationId}:`, err);
    }

    if (attempts >= maxAttempts) {
      console.log(`⏱️ Monitoring timeout for ${operationId}`);
      clearInterval(interval);
    }
  }, 1000);
}

// ========= ERROR HANDLER & START =========

app.use((err, req, res, next) => {
  console.error('Server error middleware:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   🚀 Veo 3.1 Backend Server Running       ║
║                                           ║
║   Port: ${PORT}
║   Environment: ${process.env.NODE_ENV || 'development'}
║   API Key: ${API_KEY ? '✅ Present' : '❌ MISSING'}
╚═══════════════════════════════════════════╝
  `);
});
