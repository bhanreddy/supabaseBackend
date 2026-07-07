
import { NotificationEventConfig } from '../services/notificationEventConfig.js';

let errors = 0;
const requiredFields = ['channelId', 'sound', 'titleTemplate', 'bodyTemplate', 'requiredParams'];

Object.keys(NotificationEventConfig).forEach((key) => {
  const config = NotificationEventConfig[key];
  const missing = requiredFields.filter((field) => !config[field]);

  if (missing.length > 0) {

    errors++;
  }

  if (config.channelId && config.sound) {
    const soundName = config.sound.replace('.wav', '');
    if (config.channelId !== soundName) {

    }
  }
});

if (errors === 0) {

  process.exit(0);
} else {

  process.exit(1);
}