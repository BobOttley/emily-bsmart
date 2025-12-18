# Emily Multi-School AI Assistant

Emily is an AI-powered assistant that serves multiple schools from a single instance. When any school's prospectus loads, Emily appears configured with that school's theme, knowledge base, and personality.

## Features

- **Multi-School Support**: One Emily instance serves CLC, Brighton College, BCPK, and Clifton College
- **Voice Conversations**: Real-time voice chat using OpenAI's Realtime API
- **Text Chat**: Standard text-based chat with GPT-4o-mini
- **Audio Tours**: Personalised audio narration of prospectus sections
- **School-Themed Widget**: Embeddable widget that matches each school's brand colours
- **Family Personalisation**: Uses child's name and interests to personalise responses

## Quick Start

### 1. Install dependencies

```bash
cd emily
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-your-key-here
```

### 3. Start the server

```bash
npm start
```

Server runs on http://localhost:3030

### 4. Test the widget

Open a prospectus HTML file in your browser (with a local server):

```bash
cd ../clc
python3 -m http.server 8080
```

Visit http://localhost:8080/prospectus.html - Emily should appear in the bottom right.

## API Endpoints

### Chat

- `POST /api/:schoolId/chat` - Send a message
- `POST /api/:schoolId/chat/start` - Start a new session
- `GET /api/:schoolId/chat/history/:sessionId` - Get chat history

### Audio Tours

- `GET /api/:schoolId/audio-tour/sections` - List available sections
- `GET /api/:schoolId/audio-tour/section/:sectionId` - Get section content
- `POST /api/:schoolId/audio-tour/narrate` - Generate personalised narration

### Voice

- `POST /api/:schoolId/realtime/session` - Create realtime voice session
- `POST /api/:schoolId/realtime/tool/kb_search` - Knowledge base search tool

### Widget

- `GET /widget/:schoolId/emily.js` - School-themed widget JavaScript
- `GET /widget/:schoolId/emily.css` - School-themed widget CSS

### Info

- `GET /api/schools` - List all schools
- `GET /api/schools/:schoolId` - Get school configuration
- `GET /api/health` - Health check

## Embedding the Widget

Add this to any prospectus HTML before `</body>`:

```html
<!-- Emily AI Assistant -->
<script
  src="https://emily.bsmart-ai.com/widget/clc/emily.js"
  data-school="clc"
></script>
```

Or with family context:

```html
<script
  src="https://emily.bsmart-ai.com/widget/clc/emily.js"
  data-school="clc"
  data-family-id="hamilton-family"
  data-family-context='{"parent_name":"Mrs Hamilton","child_name":"Sophia","interests":["chemistry","music"]}'
></script>
```

## School IDs

| ID | School |
|---|---|
| `clc` | Cheltenham Ladies' College |
| `brighton-college` | Brighton College |
| `bcpk` | Brighton College Prep Kensington |
| `clifton-college` | Clifton College |

## Adding a New School

1. Add configuration to `config/schools.js`
2. Create knowledge base file in `knowledge-bases/`
3. Ensure prospectus HTML has `data-module` attributes on sections
4. Deploy - Emily will automatically serve the new school

## Deployment

Deploy to Render using the `render.yaml` at the platform root:

```bash
cd ..
render blueprint sync
```

Or deploy manually:

1. Set environment variables in Render
2. Deploy from the `emily/` directory
3. Update widget URLs in prospectuses to use production URL

## Architecture

```
emily/
├── server.js           # Express server, API routes
├── config/
│   └── schools.js      # School configurations
├── routes/
│   ├── chat.js         # Text chat endpoints
│   ├── audio-tour.js   # Audio tour endpoints
│   └── health.js       # Health checks
├── realtime/
│   └── voice-handler.js # WebRTC voice handler (client-side)
├── functions/
│   └── prospectus-section.js # OpenAI function definitions
├── knowledge-bases/
│   ├── clc.md          # CLC school knowledge
│   ├── brighton-college.md
│   ├── bcpk.md
│   └── clifton-college.md
└── widget/
    ├── emily-widget.js  # Embeddable widget
    └── emily-widget.css # Widget styles
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key | Yes |
| `PORT` | Server port (default: 3030) | No |
| `NODE_ENV` | Environment (development/production) | No |
| `API_BASE_URL` | Base URL for widget API calls | No |

## License

BSMART AI - Proprietary
