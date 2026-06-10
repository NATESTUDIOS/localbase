// /api/host.js

import { db } from "../utils/firebase.js";

// ============================================
// Configuration
// ============================================
const ALLOWED_EXTENSIONS = ['html', 'css', 'js', 'txt', 'json'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DB_PATH = 'HostedFiles';

// ============================================
// Helper Functions
// ============================================

function getFileExtension(filename) {
  const parts = filename.split('.');
  if (parts.length < 2) return null;
  const ext = parts.pop().toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : null;
}

function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'txt': 'text/plain'
  };
  return types[ext] || 'text/plain';
}

function generateFileId(user_id, key, filename) {
  return `${user_id}/${key}/${filename}`;
}

// ============================================
// Main API Handler
// ============================================

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const baseUrl = `https://${req.headers.host}`;

  try {
    // ============================================
    // GET: Retrieve file using parameters
    // URL: /api/host?user_id=xxx&key=xxx&filename=xxx
    // ============================================
    
    if (req.method === 'GET') {
      const { user_id, key, filename } = req.query;

      // Validate parameters
      if (!user_id || !key) {
        return res.status(400).json({ 
          error: 'user_id and key are required' 
        });
      }

      // If no filename specified, look for index.html
      const targetFile = filename || 'index.html';

      const fileId = generateFileId(user_id, key, targetFile);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);
      const snapshot = await fileRef.once('value');

      if (!snapshot.exists()) {
        return res.status(404).json({ 
          error: 'File not found',
          message: `No file found at ${user_id}/${key}/${targetFile}`
        });
      }

      const fileData = snapshot.val();
      
      // Check expiry
      if (fileData.expiry && fileData.expiry < Date.now()) {
        return res.status(410).json({ error: 'File has expired' });
      }

      // Return the file
      res.setHeader('Content-Type', getContentType(targetFile));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(fileData.code || fileData.content);
    }

    // ============================================
    // POST: Create new file
    // Body: { user_id, key, filename, code, name }
    // ============================================
    
    if (req.method === 'POST') {
      const { user_id, key, filename, code, name } = req.body;

      // Validate required fields
      if (!user_id || !key || !filename || !code) {
        return res.status(400).json({ 
          error: 'user_id, key, filename, and code are required' 
        });
      }

      // Check file extension
      const ext = getFileExtension(filename);
      if (!ext) {
        return res.status(400).json({ 
          error: `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` 
        });
      }

      // Check file size
      if (code.length > MAX_FILE_SIZE) {
        return res.status(400).json({ 
          error: `File too large. Max ${MAX_FILE_SIZE / 1024 / 1024}MB` 
        });
      }

      const fileId = generateFileId(user_id, key, filename);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);
      
      // Check if already exists
      const existing = await fileRef.once('value');
      if (existing.exists()) {
        return res.status(409).json({ 
          error: 'File already exists. Use PUT to update.' 
        });
      }

      const now = Date.now();
      const fileData = {
        user_id,
        key,
        filename,
        name: name || filename,
        code: code,
        content: code,
        size: code.length,
        created_at: now,
        updated_at: now,
        hosttime: now,
        expiry: null
      };

      await fileRef.set(fileData);

      // Generate hosting URL
      const hostedUrl = `${baseUrl}/api/host?user_id=${user_id}&key=${key}`;
      const directUrl = `${baseUrl}/${user_id}/${key}`;

      return res.status(201).json({
        success: true,
        message: 'Project created successfully',
        url: hostedUrl,
        direct_url: directUrl,
        name: name || filename,
        key: key,
        hosttime: String(now),
        filename: filename,
        size: code.length
      });
    }

    // ============================================
    // PUT: Update existing file
    // Body: { user_id, key, filename, code, name }
    // ============================================
    
    if (req.method === 'PUT') {
      const { user_id, key, filename, code, name } = req.body;

      if (!user_id || !key || !filename || !code) {
        return res.status(400).json({ 
          error: 'user_id, key, filename, and code are required' 
        });
      }

      const fileId = generateFileId(user_id, key, filename);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);
      
      // Check if exists
      const existing = await fileRef.once('value');
      if (!existing.exists()) {
        return res.status(404).json({ error: 'File not found' });
      }

      const existingData = existing.val();
      const now = Date.now();
      
      const updates = {
        code: code,
        content: code,
        size: code.length,
        name: name || existingData.name,
        updated_at: now,
        hosttime: now
      };

      await fileRef.update(updates);

      const hostedUrl = `${baseUrl}/api/host?user_id=${user_id}&key=${key}`;

      return res.status(200).json({
        success: true,
        message: 'Project updated successfully',
        url: hostedUrl,
        name: updates.name,
        key: key,
        hosttime: String(now),
        filename: filename
      });
    }

    // ============================================
    // DELETE: Delete file
    // Query: ?user_id=xxx&key=xxx&filename=xxx
    // ============================================
    
    if (req.method === 'DELETE') {
      const { user_id, key, filename } = req.query;

      if (!user_id || !key || !filename) {
        return res.status(400).json({ 
          error: 'user_id, key, and filename are required' 
        });
      }

      const fileId = generateFileId(user_id, key, filename);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);
      
      const existing = await fileRef.once('value');
      if (!existing.exists()) {
        return res.status(404).json({ error: 'File not found' });
      }

      await fileRef.remove();

      return res.status(200).json({
        success: true,
        message: 'Project deleted successfully'
      });
    }

    // ============================================
    // GET: List all projects for a user/key
    // URL: /api/host?action=list&user_id=xxx&key=xxx
    // ============================================
    
    if (req.method === 'GET' && req.query.action === 'list') {
      const { user_id, key } = req.query;
      
      if (!user_id || !key) {
        return res.status(400).json({ 
          error: 'user_id and key are required' 
        });
      }
      
      const filesRef = db.ref(DB_PATH);
      const snapshot = await filesRef.once('value');
      
      const projects = [];
      if (snapshot.exists()) {
        snapshot.forEach((childSnapshot) => {
          const fileData = childSnapshot.val();
          if (fileData.user_id === user_id && fileData.key === key) {
            projects.push({
              name: fileData.name,
              filename: fileData.filename,
              url: `${baseUrl}/api/host?user_id=${user_id}&key=${key}&filename=${fileData.filename}`,
              direct_url: `${baseUrl}/${user_id}/${key}/${fileData.filename}`,
              hosttime: fileData.hosttime,
              created_at: fileData.created_at,
              size: fileData.size
            });
          }
        });
      }
      
      return res.status(200).json({
        success: true,
        user_id: user_id,
        key: key,
        projects: projects,
        count: projects.length,
        base_url: `${baseUrl}/api/host?user_id=${user_id}&key=${key}`
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Host API Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}