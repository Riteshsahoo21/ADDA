import { Router } from 'express';

export const healthRoutes = Router();

healthRoutes.get('/', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'ADDA Backend',
    timestamp: new Date().toISOString(),
  });
});
