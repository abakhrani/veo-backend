import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Configuration
const allowedOrigins = [
  'https://atmospheres.digicomm.online', // ✅ no trailing slash
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

// Initialize Google AI
let ai;
try {
  ai = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
  console.log('✅ Google AI initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize Google AI:', error);
}

// Store operations (in-memory, use Redis/DB for production)
const operations = new Map();

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
      status: 'GET /api/status/:id'
    }
  });
});

// API Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: !!ai,
    timestamp: new Date().toISOString()
  });
});

// Generate video
app.post('/api/generate', async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: 'Google AI not configured',
        message: 'API key may be missing or invalid'
      });
    }

    const { 
      visualPrompt, 
      audioPrompt, 
      duration = "10 seconds",
      aspectRatio = "16:9"
    } = req.body;

    if (!visualPrompt) {
      return res.status(400).json({
        error: 'Missing required field: visualPrompt'
      });
    }

    console.log(`🎬 Generating video: "${visualPrompt.substring(0, 50)}..."`);

    // Start video generation
    const result = await ai.models.generate_video({
      model: "veo-3.1-exp-002",
      visual_prompt: visualPrompt,
      audio_prompt: audioPrompt || undefined,
      duration: duration,
      aspect_ratio: aspectRatio,
      loop: false
    });

    const operationId = result.operation_id;
    
    // Store operation
    operations.set(operationId, {
      id: operationId,
      status: 'processing',
      visualPrompt,
      audioPrompt,
      duration,
      aspectRatio,
      createdAt: Date.now()
    });

    // Start monitoring in background
    monitorOperation(operationId);

    res.json({
      success: true,
      operationId: operationId,
      message: 'Video generation started',
      estimatedTime: '60 seconds'
    });

  } catch (error) {
    console.error('❌ Generation error:', error);
    res.status(500).json({
      error: 'Generation failed',
      message: error.message
    });
  }
});

// Check generation status
app.get('/api/status/:id', async (req, res) => {
  try {
    const operationId = req.params.id;
    
    // Check in-memory store first
    const stored = operations.get(operationId);
    if (!stored) {
      return res.status(404).json({
        error: 'Operation not found',
        operationId
      });
    }

    // If already completed, return stored result
    if (stored.status === 'completed' && stored.videoUrl) {
      return res.json({
        status: 'completed',
        operationId,
        videoUrl: stored.videoUrl,
        metadata: stored.metadata
      });
    }

    // Check with Google AI
    const status = await ai.models.get_operation_status({
      operation_id: operationId
    });

    if (status.done) {
      const videoUrl = status.response?.video_url || status.response?.uri;
      
      // Update stored operation
      operations.set(operationId, {
        ...stored,
        status: 'completed',
        videoUrl: videoUrl,
        metadata: status.response,
        completedAt: Date.now()
      });

      res.json({
        status: 'completed',
        operationId,
        videoUrl: videoUrl,
        metadata: status.response
      });
    } else {
      res.json({
        status: 'processing',
        operationId,
        message: 'Video is still generating...'
      });
    }

  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({
      error: 'Status check failed',
      message: error.message
    });
  }
});

// Monitor operation in background
async function monitorOperation(operationId) {
  const maxAttempts = 120; // 2 minutes max
  let attempts = 0;

  const checkInterval = setInterval(async () => {
    attempts++;

    try {
      const status = await ai.models.get_operation_status({
        operation_id: operationId
      });

      if (status.done) {
        const stored = operations.get(operationId);
        const videoUrl = status.response?.video_url || status.response?.uri;
        
        operations.set(operationId, {
          ...stored,
          status: 'completed',
          videoUrl: videoUrl,
          metadata: status.response,
          completedAt: Date.now()
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
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
