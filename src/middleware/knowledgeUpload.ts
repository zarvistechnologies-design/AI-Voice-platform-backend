import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { HttpError } from "../utils/httpError.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

export function knowledgeFileUpload(request: Request, response: Response, next: NextFunction) {
  upload.single("file")(request, response, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(new HttpError(413, "Knowledge files must be 20MB or smaller."));
      return;
    }
    next(new HttpError(400, error instanceof Error ? error.message : "Could not upload the knowledge file."));
  });
}
