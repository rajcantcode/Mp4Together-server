import Joi from "joi";
export const createUserSchema = Joi.object({
  email: Joi.string()
    .email()
    .pattern(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/)
    .required()
    .messages({
      "string.email": "Please provide a valid email address",
      "string.pattern.base": "Please provide a valid email address",
      "any.required": "Email is required",
    }),
  password: Joi.string().trim().min(8).max(15).required().messages({
    "string.min": "Password should be at least 8 characters long",
    "string.max": "Password should be at most 15 characters long",
    "any.required": "Please provide a valid password",
  }),
  username: Joi.string().trim().alphanum().min(4).max(15).required().messages({
    "string.alphanum": "Username should contain only letters and numbers",
    "string.max": "Username should be at most 15 characters long",
    "string.min": "Username should be at least 4 characters long",
    "any.required": "Please provide a valid username",
  }),
});

export const loginUserEmailSchema = Joi.object({
  email: Joi.string()
    .email()
    .pattern(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/)
    .required()
    .messages({
      "string.email": "Please provide a valid email address",
      "string.pattern.base": "Please provide a valid email address",
      "any.required": "Email is required",
    }),
  password: Joi.string().trim().min(8).max(15).required().messages({
    "string.min": "Password should be at least 8 characters long",
    "string.max": "Password should be at most 15 characters long",
    "any.required": "Please provide a valid password",
  }),
});

export const loginUserUsernameSchema = Joi.object({
  username: Joi.string().trim().alphanum().min(4).max(15).required().messages({
    "string.alphanum": "Username should contain only letters and numbers",
    "string.max": "Username should be at most 15 characters long",
    "string.min": "Username should be at least 4 characters long",
    "any.required": "Please provide a valid username",
  }),
  password: Joi.string().trim().min(8).max(15).required().messages({
    "string.min": "Password should be at least 8 characters long",
    "string.max": "Password should be at most 15 characters long",
    "any.required": "Please provide a valid password",
  }),
});

export const changeUsernameSchema = Joi.object({
  username: Joi.string().trim().alphanum().min(4).max(15).required().messages({
    "string.alphanum": "Username should contain only letters and numbers",
    "string.max": "Username should be at most 15 characters long",
    "string.min": "Username should be at least 4 characters long",
    "any.required": "Please provide a valid username",
  }),
});

export const verifyOtpSchema = Joi.object({
  email: Joi.string()
    .email()
    .pattern(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/)
    .required()
    .messages({
      "string.email": "Please provide a valid email address",
      "string.pattern.base": "Please provide a valid email address",
      "any.required": "Email is required",
    }),
  otp: Joi.string()
    .trim()
    .length(6)
    .pattern(/^[0-9]+$/)
    .required()
    .messages({
      "string.length": "OTP should be exactly 6 characters long",
      "string.pattern.base": "OTP should contain only numbers",
      "any.required": "OTP is required",
    }),
});

export const resendOtpSchema = Joi.object({
  email: Joi.string()
    .email()
    .pattern(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/)
    .required()
    .messages({
      "string.email": "Please provide a valid email address",
      "string.pattern.base": "Please provide a valid email address",
      "any.required": "Email is required",
    }),
});
