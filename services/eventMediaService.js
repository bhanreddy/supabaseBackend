import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { pickField } from './eventModuleUtils.js';

export const EventMediaService = {
  async listMedia({ schoolId, eventId, album = null }) {
    return await sql`
      SELECT m.*, p.display_name as uploader_name
      FROM event_media m
      LEFT JOIN users u ON m.uploaded_by = u.id
      LEFT JOIN persons p ON u.person_id = p.id
      WHERE m.event_id = ${eventId} AND m.school_id = ${schoolId} AND m.deleted_at IS NULL
        ${album ? sql`AND m.album = ${album}` : sql``}
      ORDER BY m.created_at DESC
    `;
  },

  async addMedia({ schoolId, eventId, data, userId }) {
    const fileUrl = pickField(data, 'file_url', 'fileUrl');
    const mediaType = String(pickField(data, 'media_type', 'mediaType') || 'PHOTO').toUpperCase();
    if (!fileUrl) {
      const err = new Error('file_url is required');
      err.statusCode = 400;
      throw err;
    }

    const [row] = await sql`
      INSERT INTO event_media (
        school_id, event_id, album, media_type, file_url, caption, visibility, uploaded_by
      ) VALUES (
        ${schoolId}, ${eventId},
        ${pickField(data, 'album') || 'General'},
        ${mediaType},
        ${fileUrl},
        ${pickField(data, 'caption') || null},
        ${pickField(data, 'visibility') || 'SCHOOL'},
        ${userId || null}
      )
      RETURNING *
    `;

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'EVENT_MEDIA_UPLOADED',
      entityType: 'EVENT_MEDIA',
      entityId: row.id,
      details: `Uploaded ${mediaType}`,
    });

    return row;
  },

  async moderateMedia({ schoolId, mediaId, status, userId }) {
    const [row] = await sql`
      UPDATE event_media
      SET moderation_status = ${status}
      WHERE id = ${mediaId} AND school_id = ${schoolId}
      RETURNING *
    `;
    if (!row) {
      const err = new Error('Media not found');
      err.statusCode = 404;
      throw err;
    }
    await EventEngineService.logAudit({
      schoolId,
      eventId: row.event_id,
      actorUserId: userId,
      action: 'EVENT_MEDIA_MODERATED',
      entityType: 'EVENT_MEDIA',
      entityId: mediaId,
      newState: { status },
    });
    return row;
  },

  async listDocuments({ schoolId, eventId }) {
    return await sql`
      SELECT d.*, p.display_name as uploader_name
      FROM event_documents d
      LEFT JOIN users u ON d.uploaded_by = u.id
      LEFT JOIN persons p ON u.person_id = p.id
      WHERE d.event_id = ${eventId} AND d.school_id = ${schoolId} AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC
    `;
  },

  async addDocument({ schoolId, eventId, data, userId }) {
    const fileUrl = pickField(data, 'file_url', 'fileUrl');
    const title = pickField(data, 'title');
    if (!fileUrl || !title) {
      const err = new Error('title and file_url are required');
      err.statusCode = 400;
      throw err;
    }
    const [row] = await sql`
      INSERT INTO event_documents (
        school_id, event_id, document_type, title, file_url, access_level, uploaded_by
      ) VALUES (
        ${schoolId}, ${eventId},
        ${pickField(data, 'document_type', 'documentType') || 'GENERAL'},
        ${title}, ${fileUrl},
        ${pickField(data, 'access_level', 'accessLevel') || 'STAFF'},
        ${userId || null}
      )
      RETURNING *
    `;
    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'EVENT_DOCUMENT_UPLOADED',
      entityType: 'EVENT_DOCUMENT',
      entityId: row.id,
      details: title,
    });
    return row;
  },
};

export default EventMediaService;
