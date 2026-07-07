import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sql from '../db.js';
import { translateToTelugu } from '../services/geminiTranslator.js';

const router = express.Router();

// Helper: Initialize AI Client safely
const getAIModel = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const genAI = new GoogleGenerativeAI(apiKey);

  // Using the model that worked for you
  return genAI.getGenerativeModel({ model: "gemini-flash-latest" });
};

// Helper: Retry Logic (Kept as is - it's good)
async function generateWithRetry(model, prompt, retries = 3, delay = 1000) {
  try {
    return await model.generateContent(prompt);
  } catch (error) {
    const isTransient = error.response?.status === 503 || error.response?.status === 429;
    const isQuota = error.message?.includes('429') || error.message?.includes('quota');

    if (isTransient && retries > 0) {

      await new Promise((res) => setTimeout(res, delay));
      return generateWithRetry(model, prompt, retries - 1, delay * 2);
    }
    throw error;
  }
}

router.post('/doubt-assist', requireAuth, async (req, res) => {
  try {
    const { question, class_level, subject } = req.body;

    if (!question) return res.status(400).json({ error: 'Question is required' });

    // 1. Initialize Model
    const model = getAIModel();
    if (!model) {
      return res.status(503).json({ error: 'AI Service Configuration Missing' });
    }

    // 2. Fetch User Class Context
    // Priority: Manual Override (req.body) > Database (req.user) > Default
    let studentClass = class_level || null;
    let studentName = req.user?.name || "Student";

    if (!studentClass && req.user && req.user.internal_id) {
      try {
        const enrollment = await sql`
                    SELECT c.name as class_name 
                    FROM student_enrollments se
                    JOIN class_sections cs ON se.class_section_id = cs.id AND cs.school_id = ${req.schoolId}
                    JOIN classes c ON cs.class_id = c.id
                    WHERE se.student_id = ${req.user.internal_id} AND se.status = 'active' AND se.school_id = ${req.schoolId}
                    LIMIT 1
                 `;
        if (enrollment.length > 0) {
          studentClass = enrollment[0].class_name;
        }
      } catch (dbError) {

      }
    }

    // Default if nothing found
    if (!studentClass) studentClass = 'General Learner';

    // LOGGING: Verify context is working

    // 3. Construct the "Strict Context" Prompt
    const finalPrompt = `
You are NexSyrus AI, a smart and friendly tutor.
You are speaking to ${studentName}.

🔴 **CRITICAL INSTRUCTIONS**:
1. **CONTEXT IS KING**: The student is in **${studentClass}**. You MUST adjust your explanation complexity to match this grade level EXACTLY.
   - If ${studentClass} is Grades 1-5: Use very simple words, fun analogies, and emojis.
   - If ${studentClass} is Grades 6-10: Use clear, structured explanations with standard examples.
   - If ${studentClass} is Grades 11-12/College: Use formal academic terminology and deep technical depth.

2. **SCOPE RESTRICTION**: Do NOT provide information that is confusingly advanced for a ${studentClass} student unless specifically asked.

3. **MANDATORY GREETING**: Start your answer EXACTLY with: "Hello from Nexsyrus AI! 👋"

4. **TASK**:
   Subject: ${subject || 'General Knowledge'}
   Question: "${question}"

Answer the question now, adhering strictly to the rules above.
`;

    // 4. Generate Content
    const result = await generateWithRetry(model, finalPrompt);
    const responseText = result.response.text();

    return sendSuccess(res, req.schoolId, {
      answer: responseText,
      context_used: studentClass, // Returning this helps you debug on frontend
      id: Date.now().toString()
    });

  } catch (error) {

    if (error.message?.includes('404') || error.message?.includes('not found')) {
      return res.status(400).json({
        error: 'Invalid AI Model',
        details: 'The selected model is not accessible. Please check your API key permissions.'
      });
    }

    if (error.message?.includes('429') || error.message?.includes('quota')) {
      return res.status(429).json({
        error: 'AI Rate Limit',
        details: 'Server is busy. Please try again in a moment.'
      });
    }

    res.status(502).json({
      error: 'AI Request Failed',
      details: error.message || 'Unknown error'
    });
  }
});

// NEW ROUTE: Hybrid Telugu Translation Endpoint
router.post('/translate', requireAuth, async (req, res) => {
  try {
    const { texts } = req.body;

    if (!texts || !Array.isArray(texts)) {
      return res.status(400).json({ error: 'texts array is required' });
    }

    // Limit chunk sizes to prevent timeouts / giant payload
    if (texts.length > 50) {
      return res.status(400).json({ error: 'Max 50 strings per request' });
    }

    const translatedTexts = await Promise.all(texts.map((t) => translateToTelugu(t)));

    return sendSuccess(res, req.schoolId, { translations: translatedTexts });
  } catch (error) {

    res.status(500).json({
      error: 'Failed to translate texts',
      details: error.message
    });
  }
});

export default router;