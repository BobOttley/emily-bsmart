/**
 * Health Check Route
 *
 * Provides endpoints for monitoring Emily service health.
 */

const express = require('express');
const router = express.Router();
const { getSchoolIds } = require('../config/schools');

/**
 * GET /api/health
 *
 * Basic health check
 */
router.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'emily-multi-school',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    schools: getSchoolIds().length
  });
});

/**
 * GET /api/health/detailed
 *
 * Detailed health check including dependencies
 */
router.get('/detailed', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'emily-multi-school',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    schools: getSchoolIds().length,
    checks: {
      openai: false,
      knowledgeBases: false
    }
  };

  // Check OpenAI API key exists
  health.checks.openai = !!process.env.OPENAI_API_KEY;

  // Check knowledge base files exist
  const fs = require('fs');
  const path = require('path');
  const { schools } = require('../config/schools');

  let kbCount = 0;
  for (const schoolId of getSchoolIds()) {
    const school = schools[schoolId];
    const kbPath = path.join(__dirname, '..', 'knowledge-bases', school.knowledgeBase);
    if (fs.existsSync(kbPath)) {
      kbCount++;
    }
  }
  health.checks.knowledgeBases = kbCount === getSchoolIds().length;
  health.knowledgeBasesLoaded = `${kbCount}/${getSchoolIds().length}`;

  // Overall status
  if (!health.checks.openai) {
    health.status = 'degraded';
    health.issues = health.issues || [];
    health.issues.push('OpenAI API key not configured');
  }

  if (!health.checks.knowledgeBases) {
    health.status = 'degraded';
    health.issues = health.issues || [];
    health.issues.push('Some knowledge bases missing');
  }

  res.json(health);
});

module.exports = router;
