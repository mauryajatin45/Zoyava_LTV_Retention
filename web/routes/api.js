import express from 'express';
import { LTV_LADDER } from '../services/ltv-config.js';

const router = express.Router();

// GET /api/ltv-config  →  Returns the LTV ladder JSON for the dashboard
router.get('/ltv-config', (req, res) => {
  res.status(200).json({ ladder: LTV_LADDER });
});

export default router;
