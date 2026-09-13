import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Isolated Academic AI Service
 * Powered by Gemini with strict guardrails: suggestions require explicit human review
 * and never claim authoritative database mutation on their own.
 */
class AcademicAIService {
  static getModel() {
    const apiKey = config.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key is not configured');
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    return genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  /**
   * Extract curriculum hierarchy from raw syllabus text, textbook index, or OCR output
   *
   * @param {Object} params
   * @param {string} params.rawText - Text extracted from syllabus PDF or table of contents image
   * @param {string} [params.subjectName]
   * @param {string} [params.className]
   * @returns {Promise<{ units: Array<{ title: string, chapters: Array<{ title: string, estimated_periods: number, topics: Array<{ title: string, estimated_periods: number }> }> }> }>}
   */
  static async extractCurriculumStructure({ rawText, subjectName, className }) {
    if (!rawText || rawText.trim().length === 0) {
      throw new Error('Syllabus text is required for AI extraction');
    }

    const model = this.getModel();

    const prompt = `
You are an expert school academic curriculum architect for K-12 education.
Analyze the following textbook index or syllabus document text for "${className || 'Class'}" - "${subjectName || 'Subject'}".

Extract the structural hierarchy of Units, Chapters, and Topics.
Format strictly as JSON with this schema:
{
  "curriculum_name": "Suggested Name",
  "units": [
    {
      "unit_title": "Unit 1: Title",
      "chapters": [
        {
          "chapter_title": "Chapter 1: Title",
          "estimated_periods": 5,
          "topics": [
            {
              "topic_title": "1.1 Topic Title",
              "estimated_periods": 2,
              "is_optional": false
            }
          ]
        }
      ]
    }
  ]
}

Rules:
1. Do not invent unrelated topics not mentioned in the text.
2. Provide reasonable estimated periods (1 to 4 periods per topic, 4 to 15 per chapter) based on topic depth.
3. Mark enrichment or extension activities as "is_optional": true.
4. Return ONLY valid JSON, with NO surrounding markdown backticks or commentary.

Document text:
${rawText.slice(0, 10000)}
`;

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return parsed;
    } catch (err) {
      logger.error({ err }, 'AcademicAIService curriculum extraction failed');
      throw new Error(`AI Curriculum Extraction failed: ${err.message}`);
    }
  }

  /**
   * Suggest a 5-period or custom breakdown lesson plan for a topic
   */
  static async suggestLessonPlan({ topicTitle, chapterTitle, className, subjectName, totalPeriods = 5 }) {
    if (!topicTitle) throw new Error('Topic title is required');

    const model = this.getModel();

    const prompt = `
Create a ${totalPeriods}-period lesson plan breakdown for:
Class: ${className || 'Middle School'}
Subject: ${subjectName || 'General'}
Chapter: ${chapterTitle || 'Core'}
Topic: ${topicTitle}

Format strictly as JSON:
{
  "learning_objective": "Clear measurable student outcome",
  "teaching_method": "Interactive discussion, visual modeling, problem solving",
  "activity": "Brief classroom activity or demonstration",
  "resources": "Textbook, blackboard, digital presentation, manipulatives",
  "assessment": "Quick exit ticket or 3-question formative check",
  "homework": "Targeted practice problems",
  "period_breakdown": [
    { "period": 1, "focus": "Introduction & Diagnostic Warm-up" },
    { "period": 2, "focus": "Core Concept Explanation & Visual Models" },
    { "period": 3, "focus": "Guided Problem Solving & Common Errors" },
    { "period": 4, "focus": "Collaborative Student Activity & Practice" },
    { "period": 5, "focus": "Formative Assessment & Review" }
  ]
}

Return ONLY valid JSON with no markdown backticks.
`;

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      return JSON.parse(cleaned);
    } catch (err) {
      logger.error({ err }, 'AcademicAIService lesson plan suggestion failed');
      throw new Error(`AI Lesson Plan suggestion failed: ${err.message}`);
    }
  }
}

export default AcademicAIService;
