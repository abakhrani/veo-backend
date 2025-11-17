import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Configuration
const allowedOrigins = [
  'https://atmospheres.digicomm.online', // no trailing slash
  'http://localhost:3000',               // local testing
  // add more allowed origins here if needed
];

app.use(cors({
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
}));

// Explicitly handle preflight requests
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// ==================== GOOGLE GEN AI INIT ====================

let ai;
try {
  // Use your existing env var name
  const apiKey =
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('No Gemini API key found in env (GOOGLE_AI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY)');
  }

  ai = new GoogleGenAI({ apiKey });
  console.log('✅ Google GenAI initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize Google GenAI:', error);
}

// Store operations (in-memory, use Redis/DB for production)
const operations = new Map();

// Simple helper to generate an internal operation ID for your frontend
function makeOperationId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2)
  );
}

// ==================== ROUTES ====================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    message: 'Veo 3.1 Backend API Server',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /',
      generate: 'POST /api/generate',
      status: 'GET /api/status/:id',
    },
  });
});

// API Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: !!ai,
    timestamp: new Date().toISOString(),
  });
});

// ==================== GENERATE VIDEO ====================

app.post('/api/generate', async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: 'Google AI not configured',
        message: 'API key may be missing or invalid',
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
        error: 'Missing required field: visualPrompt',
      });
    }

    console.log(`🎬 Generating video: "${visualPrompt.substring(0, 50)}..."`);

    // Map your duration string to seconds (Veo defaults to 8s; this is approximate)
    const durationMap = {
      '5 seconds': 5,
      '10 seconds': 10,
      '20 seconds': 20,
      '30 seconds': 30,
    };
    const durationSeconds = durationMap[duration] || 10;

    // Start video generation with Veo 3.1 via Gemini API
    let operation = await ai.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt: visualPrompt,
      // Optional config; you can tune further later
      config: {
        durationSeconds,
        aspectRatio, // "16:9", "9:16", "1:1", etc.
        // NOTE: audioPrompt support is evolving; for now we just send it through in prompt if needed
      },
    });

    // Create an internal ID that your frontend uses
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
      // Store the remote operation object; we pass this back to getVideosOperation
      remoteOperation: operation,
      videoUrl: null,
      metadata: null,
    });

    // Start monitoring in background
    monitorOperation(operationId);

    res.json({
      success: true,
      operationId,
      message: 'Video generation started',
      estimatedTime: '60 seconds',
    });
  } catch (error) {
    console.error('❌ Generation error:', error);
    res.status(500).json({
      error: 'Generation failed',
      message: error.message,
    });
  }
});

// ==================== CHECK GENERATION STATUS ====================

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

    // If already completed and we have URL, return quickly
    if (stored.status === 'completed' && stored.videoUrl) {
      return res.json({
        success: true,
        status: 'completed',
        operationId,
        videoUrl: stored.videoUrl,
        metadata: stored.metadata,
      });
    }

    if (!stored.remoteOperation) {
      return res.status(500).json({
        error: 'Missing remote operation data',
        operationId,
      });
    }

    // Refresh status from Gemini/Veo
    let op = await ai.operations.getVideosOperation({
      operation: stored.remoteOperation,
    });

    // Update the stored remote operation
    stored.remoteOperation = op;

    if (op.done) {
      const videoObj =
        op.response?.generatedVideos?.[0]?.video || null;

      // Try to extract a URI if the SDK exposes it
      const videoUrl =
        videoObj?.uri ||
        videoObj?.videoUri ||
        null;

      stored.status = 'completed';
      stored.videoUrl = videoUrl;
      stored.metadata = op.response;
      stored.completedAt = Date.now();

      return res.json({
        success: true,
        status: 'completed',
        operationId,
        videoUrl,
        metadata: op.response,
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

// ==================== MONITOR IN BACKGROUND ====================

async function monitorOperation(operationId) {
  const maxAttempts = 120; // 2 minutes max if checking every second
  let attempts = 0;

  const checkInterval = setInterval(async () => {
    attempts++;

    const stored = operations.get(operationId);
    if (!stored || !stored.remoteOperation) {
      clearInterval(checkInterval);
      return;
    }

    try {
      let op = await ai.operations.getVideosOperation({
        operation: stored.remoteOperation,
      });

      stored.remoteOperation = op;

      if (op.done) {
        const videoObj =
          op.response?.generatedVideos?.[0]?.video || null;

        const videoUrl =
          videoObj?.uri ||
          videoObj?.videoUri ||
          null;

        operations.set(operationId, {
          ...stored,
          status: 'completed',
          videoUrl,
          metadata: op.response,
          completedAt: Date.now(),
        });

        console.log(`✅ Video ready: ${operationId}`);
        clearInterval(checkInterval);
      }
    } catch (error) {
      console.error(`❌ Monitoring error for ${operationId}:`, error);
    }

    if (attempts >= maxAttempts) {
      console.log(`⏱️ Monitoring timeout for ${operationId}`);
      clearInterval(checkInterval);
    }
  }, 1000); // Check every second
}

// ==================== ERROR HANDLER & START ====================

app.use((err, req, res, next) => {
  console.error('Server error:', err);
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
║   AI Status: ${ai ? '✅ Ready' : '❌ Not configured'}
╚═══════════════════════════════════════════╝
  `);
});
