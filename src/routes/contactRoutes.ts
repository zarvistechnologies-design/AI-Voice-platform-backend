import { Router } from "express";

import { submitContactRequest } from "../controllers/contactController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const contactRouter = Router();

contactRouter.post("/", asyncHandler(submitContactRequest));
