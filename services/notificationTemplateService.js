/**
 * Notification Template Service
 * 
 * Centralized template rendering for all notification types.
 * Uses NotificationEventConfig as the source of truth.
 */
import { NotificationEventConfig } from './notificationEventConfig.js';

export const NotificationTemplateService = {
    /**
     * Renders a notification template.
     * @param {string} type - One of the template keys from NotificationEventConfig
     * @param {object} params - Dynamic parameters
     * @param {string} [languageCode='en'] - Language code ('en' or 'te')
     * @returns {object} { title, body, deepLink, android: { channelId } }
     * @throws {Error} If type is invalid or params are missing
     */
    render(type, params, languageCode = 'en') {
        const config = NotificationEventConfig[type];
        if (!config) {
            throw new Error(`Invalid notification type: ${type}`);
        }

        // Fix 11: Falsy param validation rejects valid values
        const requiredParams = config.requiredParams || [];
        const missingParams = requiredParams.filter(p => params[p] === undefined || params[p] === null);
        if (missingParams.length > 0) {
            throw new Error(`Missing required parameters for ${type}: ${missingParams.join(', ')}`);
        }

        // Select Telugu or English templates (fall back to English if Telugu missing)
        const useTelugu = languageCode === 'te';
        let title = (useTelugu && config.titleTemplate_te) ? config.titleTemplate_te : config.titleTemplate;
        let body = (useTelugu && config.bodyTemplate_te) ? config.bodyTemplate_te : config.bodyTemplate;

        // Auto fallback for _te parameters to their English counterparts
        const finalParams = { ...params };
        Object.keys(finalParams).forEach(key => {
            if (!key.endsWith('_te')) {
                const teKey = key + '_te';
                if (finalParams[teKey] === undefined) {
                    finalParams[teKey] = finalParams[key];
                }
            }
        });

        // Replace placeholders
        Object.keys(finalParams).forEach(key => {
            const value = finalParams[key];

            // Fix 9: Escape dynamic RegExp keys
            const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`{{${escapedKey}}}`, 'g');
            title = title.replace(regex, value);
            body = body.replace(regex, value);
        });

        // Fix 10: Overly strict {{ sanity check
        if (/\{\{[^}]+\}\}/.test(body) || /\{\{[^}]+\}\}/.test(title)) {
            throw new Error(`Template rendering failed. Unreplaced placeholders in ${type}`);
        }

        return {
            title,
            body,
            deepLink: config.deepLink,
            android: {
                channelId: config.channelId
            }
        };
    }
};
