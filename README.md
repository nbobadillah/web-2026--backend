# ClearUp Backend

Backend separado para `WEB-2026`.

## Ejecutar

```bash
node server.js
```

O:

```bash
npm run dev
```

## Variables de entorno

- `PORT`: puerto del servidor
- `FRONTEND_BASE_URL`: URL pública del frontend para redirecciones
- `FRONTEND_ORIGIN`: orígenes permitidos por CORS, separados por coma
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

## Endpoints principales

- `GET /health`
- `GET /api/auth/session`
- `POST /api/auth/sign-up`
- `POST /api/auth/sign-in`
- `POST /api/auth/sign-out`
- `GET /api/auth/profile`
- `PATCH /api/auth/profile`
- `GET /api/activities`
- `PUT /api/activities`
- `GET /api/google-calendar/connect`
- `GET /api/google-calendar/callback`
- `GET /api/google-calendar/events`
