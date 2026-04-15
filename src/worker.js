/**
 * Cloudflare Worker - Image Hosting for PicGo/PicList
 * 兼容 PicGo/PicList 上传接口，将图片存储到 WebDAV
 * 
 *    设置环境变量（Settings > Variables and Secrets）：
 *    - WEBDAV_URL: WebDAV 服务器地址（文件将直接存储在此路径下）
 *    - WEBDAV_USERNAME: 用户名
 *    - WEBDAV_PASSWORD: 密码
 *    - UPLOAD_TOKEN: 上传验证 token（可选）
 *    - CUSTOM_DOMAIN: 自定义域名（可选）
 *    - ALLOWED_DOMAINS: 允许访问的域名列表，逗号分隔（可选，用于防盗链）
 *                      例如: example.com,www.example.com,blog.example.com
 *                      留空则允许所有来源访问
 */

/**
 * 计算 SHA-256 哈希值（取前16位）
 * @param {ArrayBuffer} arrayBuffer - 文件数据
 * @returns {Promise<string>} - 16位哈希字符串
 */
async function calculateHash(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const fullHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return fullHash.substring(0, 16); // 取前16位
}

/**
 * 生成哈希文件名（用于去重）
 * @param {ArrayBuffer} arrayBuffer - 文件数据
 * @param {string} originalName - 原始文件名
 * @returns {Promise<string>} - 哈希文件名
 */
async function generateHashFileName(arrayBuffer, originalName) {
  const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
  const hash = await calculateHash(arrayBuffer);
  return `${hash}.${ext}`;
}

/**
 * 检查文件是否已存在于 WebDAV
 * @param {object} env - 环境变量
 * @param {string} fileName - 文件名
 * @returns {Promise<boolean>} - 是否存在
 */
async function checkFileExists(env, fileName) {
  const webdavUrl = `${env.WEBDAV_URL}/${fileName}`;
  try {
    const response = await fetch(webdavUrl, {
      method: 'HEAD',
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.WEBDAV_USERNAME}:${env.WEBDAV_PASSWORD}`),
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 生成唯一文件名（直接存储，不分目录）
 * 注意：Koofr 不支持直接上传到不存在的子目录
 * @deprecated 使用 generateHashFileName 替代
 */
function generateFileName(originalName) {
  const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}_${random}.${ext}`;
}

/**
 * 验证上传 token
 */
function validateToken(request, env) {
  if (!env.UPLOAD_TOKEN) return true;
  
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7) === env.UPLOAD_TOKEN;
  }
  
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get('token');
  if (tokenParam) {
    return tokenParam === env.UPLOAD_TOKEN;
  }
  
  return false;
}

/**
 * 验证防盗链 - 检查 Referer 是否在允许列表中
 * 支持的通配符格式：
 *   - example.com        精确匹配
 *   - .example.com       匹配所有子域名（如 www.example.com, blog.example.com）
 *   - *.example.com     同上，匹配所有子域名
 *   - **.example.com    匹配所有子域名和主域名
 * 
 * @returns { valid: boolean, reason: string }
 */
function validateReferer(request, env) {
  // 如果没有配置允许域名，则允许所有访问
  if (!env.ALLOWED_DOMAINS) {
    return { valid: true };
  }
  
  const referer = request.headers.get('Referer');
  
  // 没有 Referer 的情况（直接访问、书签、API 调用等）
  // 可以根据需求修改此逻辑，当前允许无 Referer 的访问
  if (!referer) {
    return { valid: true };
  }
  
  try {
    const refererUrl = new URL(referer);
    const refererHost = refererUrl.hostname.toLowerCase();
    
    // 解析允许的域名列表
    const allowedDomains = env.ALLOWED_DOMAINS
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(d => d.length > 0);
    
    // 检查是否匹配
    const isAllowed = allowedDomains.some(domain => {
      // **.example.com - 匹配所有子域名和主域名
      if (domain.startsWith('**.')) {
        const baseDomain = domain.substring(3);
        return refererHost === baseDomain || refererHost.endsWith('.' + baseDomain);
      }
      
      // *.example.com 或 .example.com - 匹配所有子域名
      if (domain.startsWith('*.') || domain.startsWith('.')) {
        const baseDomain = domain.startsWith('*.') ? domain.substring(2) : domain.substring(1);
        return refererHost.endsWith('.' + baseDomain) || refererHost === baseDomain;
      }
      
      // 精确匹配
      return refererHost === domain;
    });
    
    if (isAllowed) {
      return { valid: true };
    }
    
    return { 
      valid: false, 
      reason: `Domain ${refererHost} is not allowed. Allowed domains: ${allowedDomains.join(', ')}` 
    };
  } catch (e) {
    // Referer URL 解析失败，允许访问
    return { valid: true };
  }
}

/**
 * 上传文件到 WebDAV
 */
async function uploadToWebDAV(env, fileName, fileData, contentType) {
  // 直接在 WEBDAV_URL 下存储文件
  const webdavUrl = `${env.WEBDAV_URL}/${fileName}`;
  
  try {
    const response = await fetch(webdavUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.WEBDAV_USERNAME}:${env.WEBDAV_PASSWORD}`),
        'Content-Type': contentType,
        'Content-Length': fileData.byteLength.toString(),
      },
      body: fileData,
    });
    
    if (response.ok || response.status === 201 || response.status === 204) {
      // 构建直链 URL：确保有 https:// 前缀
      let directUrl;
      if (env.CUSTOM_DOMAIN) {
        // 确保 CUSTOM_DOMAIN 有 https:// 前缀
        let customDomain = env.CUSTOM_DOMAIN;
        if (!customDomain.startsWith('http://') && !customDomain.startsWith('https://')) {
          customDomain = 'https://' + customDomain;
        }
        // 移除结尾斜杠
        customDomain = customDomain.replace(/\/+$/, '');
        directUrl = `${customDomain}/${fileName}`;
      } else {
        directUrl = webdavUrl;
      }
      return { success: true, url: directUrl };
    } else {
      return { 
        success: false, 
        error: `WebDAV upload failed: ${response.status} ${response.statusText}` 
      };
    }
  } catch (error) {
    return { 
      success: false, 
      error: `WebDAV error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * 解析 multipart/form-data
 */
async function parseMultipartFormData(request) {
  const formData = await request.formData();
  const result = new Map();
  
  for (const [key, value] of formData.entries()) {
    if (value && typeof value === 'object' && 'arrayBuffer' in value && 'name' in value) {
      result.set(key, {
        value: await value.arrayBuffer(),
        filename: value.name,
        contentType: value.type || 'application/octet-stream',
      });
    } else {
      result.set(key, {
        value: new TextEncoder().encode(String(value)).buffer,
      });
    }
  }
  
  return result;
}

/**
 * 处理上传请求
 */
async function handleUpload(request, env) {
  if (!validateToken(request, env)) {
    return jsonResponse({ status: false, message: 'Invalid or missing token' }, 401);
  }
  
  const contentType = request.headers.get('Content-Type') || '';
  const files = [];
  
  if (contentType.includes('multipart/form-data')) {
    const formData = await parseMultipartFormData(request);
    const fileFields = ['file', 'files', 'image', 'images'];
    
    for (const field of fileFields) {
      const item = formData.get(field);
      if (item && item.filename) {
        files.push({
          data: item.value,
          name: item.filename,
          type: item.contentType || 'image/png',
        });
      }
    }
  } else if (contentType.includes('application/json')) {
    const body = await request.json();
    const base64Data = body.image || body.base64 || (body.images?.[0]);
    
    if (base64Data) {
      const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUrlMatch) {
        const type = dataUrlMatch[1];
        const base64 = dataUrlMatch[2];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        files.push({
          data: bytes.buffer,
          name: 'image.png',
          type: type,
        });
      }
    }
  } else if (contentType.includes('application/octet-stream') || contentType.startsWith('image/')) {
    const url = new URL(request.url);
    const filename = url.searchParams.get('name') || 'image.png';
    files.push({
      data: await request.arrayBuffer(),
      name: filename,
      type: contentType,
    });
  }
  
  if (files.length === 0) {
    return jsonResponse({ status: false, message: 'No file uploaded' }, 400);
  }
  
  const results = [];
  
  for (const file of files) {
    // 使用哈希文件名实现去重
    const fileName = await generateHashFileName(file.data, file.name);
    
    // 检查文件是否已存在
    const fileExists = await checkFileExists(env, fileName);
    
    let uploadResult;
    if (fileExists) {
      // 文件已存在，直接返回 URL（跳过上传）
      let directUrl;
      if (env.CUSTOM_DOMAIN) {
        let customDomain = env.CUSTOM_DOMAIN;
        if (!customDomain.startsWith('http://') && !customDomain.startsWith('https://')) {
          customDomain = 'https://' + customDomain;
        }
        customDomain = customDomain.replace(/\/+$/, '');
        directUrl = `${customDomain}/${fileName}`;
      } else {
        directUrl = `${env.WEBDAV_URL}/${fileName}`;
      }
      uploadResult = { success: true, url: directUrl, skipped: true };
    } else {
      // 文件不存在，执行上传
      uploadResult = await uploadToWebDAV(env, fileName, file.data, file.type);
    }
    
    if (uploadResult.success) {
      results.push({
        success: true,
        data: {
          url: uploadResult.url,
          name: fileName,
          size: file.data.byteLength,
          skipped: uploadResult.skipped || false,
        },
      });
    } else {
      results.push({
        success: false,
        message: uploadResult.error,
      });
    }
  }
  
  if (results.length === 1) {
    const result = results[0];
    if (result.success) {
      // 兼容 Twikoo/Lsky Pro v2 格式
      // Twikoo 检查 uploadResult.data.status，并使用 res.data.links.url
      return jsonResponse({
        status: true,
        data: {
          links: {
            url: result.data.url,
          },
          name: result.data.name,
        },
      });
    } else {
      return jsonResponse({ status: false, message: result.message }, 500);
    }
  }
  
  return jsonResponse({
    status: results.every(r => r.success),
    data: results.map(r => r.data),
    message: results.find(r => !r.success)?.message,
  });
}

/**
 * JSON 响应辅助函数
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * 主处理函数 - Worker 入口
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    
    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    
    // 首页
    if (url.pathname === '/' || url.pathname === '') {
      if (method === 'GET') {
        return jsonResponse({
          name: 'CF Image Host (WebDAV)',
          version: '1.0.0',
          description: 'Cloudflare Worker for image hosting with WebDAV storage',
          endpoints: {
            upload: 'POST /upload',
            health: 'GET /health',
          },
        });
      }
    }
    
    // 上传接口（支持多种路径）
    if ((url.pathname === '/upload' || url.pathname === '/api/v1/upload') && method === 'POST') {
      return handleUpload(request, env);
    }
    
    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }
    
    // 图片代理：GET 请求从 WebDAV 获取图片
    if (method === 'GET') {
      return handleImageProxy(request, env, ctx);
    }
    
    // 404
    return jsonResponse({ status: false, message: 'Not Found' }, 404);
  },
};

/**
 * 图片代理：从 WebDAV 获取图片并返回（使用 CF Cache API 缓存）
 * @param {Request} request - 请求对象
 * @param {object} env - 环境变量
 * @param {object} ctx - Worker 上下文（用于 waitUntil）
 */
async function handleImageProxy(request, env, ctx) {
  const url = new URL(request.url);
  // 获取文件名（路径中的最后一部分）
  const fileName = url.pathname.replace(/^\/+/, '');
  
  if (!fileName) {
    return jsonResponse({ status: false, message: 'No file specified' }, 400);
  }
  
  // 防盗链检查
  const refererCheck = validateReferer(request, env);
  if (!refererCheck.valid) {
    // 返回 403 Forbidden
    return new Response('Forbidden: Hotlinking not allowed', {
      status: 403,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  
  // 尝试从 CF Cache 获取
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  
  // 检查缓存
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    // 缓存命中，直接返回
    return cachedResponse;
  }
  
  // 构建 WebDAV URL
  const webdavUrl = `${env.WEBDAV_URL}/${fileName}`;
  
  try {
    const response = await fetch(webdavUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.WEBDAV_USERNAME}:${env.WEBDAV_PASSWORD}`),
      },
    });
    
    if (response.ok) {
      const contentType = response.headers.get('Content-Type') || 'image/png';
      
      // 创建可缓存的响应
      const responseToCache = new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable', // 缓存 1 年
          'Access-Control-Allow-Origin': '*',
          'CDN-Cache-Control': 'public, max-age=31536000, immutable', // 指示 CDN 缓存
        },
      });
      
      // 存入 CF Cache（使用 waitUntil 异步执行，不阻塞响应）
      ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
      
      return responseToCache;
    } else {
      return jsonResponse({ status: false, message: `Image not found: ${response.status}` }, 404);
    }
  } catch (error) {
    return jsonResponse({ status: false, message: `Proxy error: ${error.message}` }, 500);
  }
}