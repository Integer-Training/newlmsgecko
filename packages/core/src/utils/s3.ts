import {
  DeleteObjectCommand,
  DeleteObjectCommandInput,
  GetObjectCommand,
  GetObjectCommandInput,
  PutObjectCommand,
  PutObjectCommandInput
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getPresignS3Client, getS3Client, getStorageConfig } from '../config/storage';
import { logRedisUnavailableOnce, redis } from './redis/redis';

export type GetSignedUrlParameters = Parameters<typeof getSignedUrl>;

const PRESIGN_CACHE_TTL_SECONDS = 3000; // 50 min; presigned URLs typically valid 1 hour
const PRESIGN_CACHE_KEY_PREFIX = 'presign:download:';

export async function uploadToS3(params: PutObjectCommandInput): Promise<{ success: boolean; error?: string }> {
  try {
    await getS3Client().send(new PutObjectCommand(params));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function getFromS3(
  params: GetObjectCommandInput
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const data = await getS3Client().send(new GetObjectCommand(params));
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function deleteFromS3(params: DeleteObjectCommandInput): Promise<{ success: boolean; error?: string }> {
  try {
    await getS3Client().send(new DeleteObjectCommand(params));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Generates presigned URLs for download for a list of keys in a specific bucket.
 * Uses Redis cache to avoid repeated S3 getSignedUrl calls for the same file.
 * @param keys Array of S3 keys
 * @param bucketName Bucket name (e.g., 'videos', 'documents')
 * @returns Record mapping keys to presigned URLs
 */
export async function generateDownloadPresignedUrls(
  keys: string[],
  bucketName: string
): Promise<Record<string, string>> {
  const signedUrls: Record<string, string> = {};
  const config = getStorageConfig();
  const client = getPresignS3Client();

  if (keys.length === 0) {
    return signedUrls;
  }

  const cacheKeys = keys.map((key) => `${PRESIGN_CACHE_KEY_PREFIX}${bucketName}:${key}`);

  let cachedValues: (string | null)[] | null = null;
  try {
    cachedValues = await redis.mGet(cacheKeys);
  } catch (error) {
    logRedisUnavailableOnce('Redis cache unavailable for presigned URLs, falling back to S3', error);
  }

  const keysToGenerate: string[] = [];
  if (cachedValues) {
    cachedValues.forEach((val, i) => {
      if (val) {
        signedUrls[keys[i]] = val;
      } else {
        keysToGenerate.push(keys[i]);
      }
    });
  } else {
    keysToGenerate.push(...keys);
  }

  if (keysToGenerate.length === 0) {
    return signedUrls;
  }

  const urlPromises = keysToGenerate.map(async (key) => {
    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key
      }) as GetSignedUrlParameters[1];

      const presignedUrl = await getSignedUrl(client as GetSignedUrlParameters[0], command, {
        expiresIn: config.presignDownloadExpiresSeconds
      });

      return { key, presignedUrl };
    } catch (error) {
      console.error(`Failed to generate presigned URL for key "${key}" in bucket "${bucketName}":`, error);
      return null;
    }
  });

  const results = await Promise.all(urlPromises);

  try {
    const pipeline = redis.multi();
    results.forEach((result) => {
      if (result) {
        signedUrls[result.key] = result.presignedUrl;
        const cacheKey = `${PRESIGN_CACHE_KEY_PREFIX}${bucketName}:${result.key}`;
        pipeline.setEx(cacheKey, PRESIGN_CACHE_TTL_SECONDS, result.presignedUrl);
      }
    });
    await pipeline.exec();
  } catch (error) {
    logRedisUnavailableOnce('Redis cache write unavailable for presigned URLs, continuing without cache', error);
    // URLs are already in signedUrls; cache write failure is non-fatal
  }

  return signedUrls;
}

/**
 * Generates a presigned URL for upload
 * @param fileKey S3 key for the file
 * @param bucketName Bucket name (e.g., 'videos', 'documents')
 * @param contentType MIME type of the file
 * @returns Presigned URL for upload
 */
export async function generateUploadPresignedUrl(
  fileKey: string,
  bucketName: string,
  contentType: string
): Promise<string> {
  const config = getStorageConfig();
  const client = getPresignS3Client();

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
    ContentType: contentType
  }) as GetSignedUrlParameters[1];

  const presignedUrl = await getSignedUrl(client as GetSignedUrlParameters[0], command, {
    expiresIn: config.presignUploadExpiresSeconds
  });

  return presignedUrl;
}

/** 6h presigned GET for private transcript VTT objects (not Redis-cached). */
export const TRANSCRIPT_VTT_PRESIGN_SECONDS = 21_600;

export async function generateTranscriptVttPresignedUrl(key: string, bucketName: string): Promise<string> {
  const client = getPresignS3Client();

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  }) as GetSignedUrlParameters[1];

  return getSignedUrl(client as GetSignedUrlParameters[0], command, {
    expiresIn: TRANSCRIPT_VTT_PRESIGN_SECONDS
  });
}

/**
 * Generates presigned URLs for video download
 * @param keys Array of video keys
 * @returns Record mapping keys to presigned URLs
 */
export async function generateVideoDownloadPresignedUrls(keys: string[]): Promise<Record<string, string>> {
  const config = getStorageConfig();
  return generateDownloadPresignedUrls(keys, config.bucketVideos);
}

/**
 * Generates presigned URLs for document download
 * @param keys Array of document keys
 * @returns Record mapping keys to presigned URLs
 */
export async function generateDocumentDownloadPresignedUrls(keys: string[]): Promise<Record<string, string>> {
  const config = getStorageConfig();
  return generateDownloadPresignedUrls(keys, config.bucketDocuments);
}

/**
 * Generates a presigned URL for video upload
 * @param fileKey S3 key for the video file
 * @param contentType MIME type of the video file
 * @returns Presigned URL for upload
 */
export async function generateVideoUploadPresignedUrl(fileKey: string, contentType: string): Promise<string> {
  const config = getStorageConfig();
  return generateUploadPresignedUrl(fileKey, config.bucketVideos, contentType);
}

/**
 * Generates a presigned URL for document upload
 * @param fileKey S3 key for the document file
 * @param contentType MIME type of the document file
 * @returns Presigned URL for upload
 */
export async function generateDocumentUploadPresignedUrl(fileKey: string, contentType: string): Promise<string> {
  const config = getStorageConfig();
  return generateUploadPresignedUrl(fileKey, config.bucketDocuments, contentType);
}

/**
 * Presigned GET that forces a download (Content-Disposition: attachment with an RFC 5987 filename). Short-lived
 * (~5 min) and NOT cached, so each call is tied to an audited request. Returns null when signing fails.
 */
export async function generateAttachmentPresignedUrl(
  key: string,
  bucketName: string,
  fileName: string,
  expiresInSeconds = 300
): Promise<string | null> {
  try {
    const safeAscii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\;]/g, '_') || 'download';
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
    }) as GetSignedUrlParameters[1];
    return await getSignedUrl(getPresignS3Client() as GetSignedUrlParameters[0], command, {
      expiresIn: expiresInSeconds
    });
  } catch (error) {
    console.error(`Failed to generate attachment URL for key "${key}" in bucket "${bucketName}":`, error);
    return null;
  }
}

/**
 * Opens an object as a stream (for the API to proxy inline so no S3 URL reaches the browser). Returns null when
 * the object is missing or S3 fails. `body` is a Node Readable in the node runtime.
 */
export async function getS3ObjectStream(
  key: string,
  bucketName: string
): Promise<{ body: NodeJS.ReadableStream; contentType: string | undefined; contentLength: number | undefined } | null> {
  try {
    const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    if (!res.Body) return null;
    return {
      body: res.Body as unknown as NodeJS.ReadableStream,
      contentType: res.ContentType,
      contentLength: res.ContentLength
    };
  } catch (error) {
    console.error(`Failed to open S3 object "${key}" in bucket "${bucketName}":`, error);
    return null;
  }
}
