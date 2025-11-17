# Veo 3.1 Backend API

Backend server for Google Veo 3.1 video generation.

## Deployment on Render.com

1. Push this repo to GitHub
2. Create new Web Service on Render.com
3. Connect your GitHub repo
4. Add environment variables
5. Deploy!

## Environment Variables

- `GOOGLE_AI_API_KEY` - Your Google AI API key

## Endpoints

- `GET /` - Health check
- `POST /api/generate` - Start video generation
- `GET /api/status/:id` - Check generation status