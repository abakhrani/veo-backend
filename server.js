import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Readable } from 'node:stream';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// === API KEY + BASE URL ===
const API_KEY =
  process.env.GOOGLE_AI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GEMINI_API_KEY;

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Public URL of this backend (used to build video URLs for the frontend)
const PUBLIC_BACKEND_URL =
  process.env.PUBLIC_BACKEND_URL || 'https://veo-backend-miym.onrender.com';

if (!API_KEY) {
  console.error(
    '❌ No Gemini/Veo API key found. Set GOOGLE_AI_API_KEY or GOOGLE_API_KEY or GEMINI_API_KEY in Render.'
  );
}

// === CORS CONFIG ===
const allowedOrigins = [
  'https://atmospheres.digicomm.online',
  'http://localhost:3000',
];

app.use(
  cors({
    origin(origin, callback) {
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

// Preflight
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// === Helper: extract video URI from Veo response ===
function extractVideoUri(response) {
  if (!response) return null;

  // Official Veo 3.1 structure:
  // response.generateVideoResponse.generatedSamples[0].video.uri
  if (
    response.generateVideoResponse &&
    Array.isArray(response.generateVideoResponse.generatedSamples) &&
    response.generateVideoResponse.generatedSamples[0]?.video?.uri
  ) {
    return response.generateVideoResponse.generatedSamples[0].video.uri;
  }

  // Fallbacks for slightly different shapes, just in case:
  if (response.result?.generatedVideos?.[0]?.video?.uri) {
    return response.result.generatedVideos[0].video.uri;
  }
  if (response.result?.generatedVideos?.[0]?.uri) {
    return response.result.generatedVideos[0].uri;
  }

  console.warn('⚠️ Could not extract videoUri from response:', JSON.stringify(response));
  return null;
}

// === ROUTES ===

// Root info
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    message: 'Veo 3.1 Backend API Server',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /api/health',
      generate: 'POST /api/generate',
      status: 'GET /api/status/:id',
      video: 'GET /api/video/:id',
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

// === GENERATE VIDEO ===
app.post('/api/generate', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Google AI not configured',
        message:
          'Missing API key (GOOGLE_AI_API_KEY / GOOGLE_API_KEY / GEMINI_API_KEY)',
      });
    }

    const {
      visualPrompt,
      audioPrompt,
      duration = '10 seconds',
      aspectRatio = '16:9',
    } = req.body;

    if (!visualPrompt) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: visualPrompt',
      });
    }

    console.log(
      `🎬 Generating video for prompt: "${visualPrompt.substring(0, 80)}..."`
    );

    const combinedPrompt = audioPrompt
      ? `${visualPrompt}\n\nAudio description: ${audioPrompt}`
      : visualPrompt;

    const durationMap = {
      '5 seconds': 5,
      '10 seconds': 10,
      '20 seconds': 20,
      '30 seconds': 30,
    };
    const durationSeconds = durationMap[duration] || 10;

    // Call Veo long-running endpoint
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
            },
          ],
          parameters: {
            aspectRatio,
            durationSeconds,
          },
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error('❌ Veo generation HTTP error:', resp.status, text);
      return res.status(500).json({
        success: false,
        error: 'Generation failed',
        message: `Veo HTTP ${resp.status}: ${text}`,
      });
    }

    const data = await resp.json();
    const operationName = data.name; // e.g. "models/veo-3.1-generate-preview/operations/123..."
    if (!operationName) {
      console.error('❌ Veo response missing operation name:', data);
      return res.status(500).json({
        success: false,
        error: 'Generation failed',
        message: 'Veo response missing operation name',
      });
    }

    // Use URL-encoded operationName as ID (no in-memory map needed)
    const operationId = encodeURIComponent(operationName);

    res.json({
      success: true,
      operationId,
      message: 'Video generation started',
      estimatedTime: '60–90 seconds',
    });
  } catch (error) {
    console.error('❌ Generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Generation failed',
      message: error.message,
    });
  }
});

// === STATUS CHECK ===
app.get('/api/status/:id', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Google AI not configured',
      });
    }

    const operationId = req.params.id;
    const operationName = decodeURIComponent(operationId); // back to Google's name

    const statusResp = await fetch(`${BASE_URL}/${operationName}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': API_KEY },
    });

    if (!statusResp.ok) {
      const text = await statusResp.text();
      console.error('❌ Status HTTP error:', statusResp.status, text);
      return res.status(500).json({
        success: false,
        error: 'Status check failed',
        message: `Veo status HTTP ${statusResp.status}: ${text}`,
      });
    }

    const json = await statusResp.json();

    if (!json.done) {
      return res.json({
        success: true,
        status: 'processing',
        operationId,
        message: 'Video is still generating...',
      });
    }

    const videoUri = extractVideoUri(json.response);
    if (!videoUri) {
      return res.status(500).json({
        success: false,
        status: 'failed',
        error: 'Video URI not found in Veo response',
        rawResponse: json,
      });
    }

    const publicVideoUrl = `${PUBLIC_BACKEND_URL}/api/video/${operationId}`;

    return res.json({
      success: true,
      status: 'completed',
      operationId,
      videoUrl: publicVideoUrl,
      metadata: json.response,
    });
  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({
      success: false,
      error: 'Status check failed',
      message: error.message,
    });
  }
});

// === VIDEO PROXY (STREAM VIDEO TO BROWSER) ===
app.get('/api/video/:id', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: 'Google AI not configured',
      });
    }

    const operationId = req.params.id;
    const operationName = decodeURIComponent(operationId);

    // Get latest operation status to obtain the video URI
    const statusResp = await fetch(`${BASE_URL}/${operationName}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': API_KEY },
    });

    if (!statusResp.ok) {
      const text = await statusResp.text();
      console.error('❌ Video status HTTP error:', statusResp.status, text);
      return res.status(statusResp.status).send(text);
    }

    const json = await statusResp.json();
    if (!json.done) {
      return res.status(202).json({
        error: 'Video not ready yet',
        status: 'processing',
      });
    }

    const videoUri = extractVideoUri(json.response);
    if (!videoUri) {
      return res.status(500).json({
        error: 'Video URI not found in Veo response',
      });
    }

    // videoUri is something like: "files/abc123:download?alt=media"
    const downloadUrl = `${BASE_URL}/${videoUri}`;

    const videoResp = await fetch(downloadUrl, {
      method: 'GET',
      headers: { 'x-goog-api-key': API_KEY },
    });

    if (!videoResp.ok) {
      const text = await videoResp.text();
      console.error('❌ Video download HTTP error:', videoResp.status, text);
      return res.status(videoResp.status).send(text);
    }

    const contentType =
      videoResp.headers.get('content-type') || 'video/mp4';
    const contentLength = videoResp.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    // Stream to browser
    const nodeStream = Readable.fromWeb(videoResp.body);
    nodeStream.pipe(res);
  } catch (error) {
    console.error('❌ Video proxy error:', error);
    res.status(500).json({
      error: 'Video proxy failed',
      message: error.message,
    });
  }
});

// === ERROR HANDLER & START ===
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
