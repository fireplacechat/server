// Not the deployed policy (decision 0018). The hook needs this shape.
// Every report is queued for a person. This file has no threshold.

export const POLICY = {
  reportWindowMs: 0,
  assess() {
    return { action: 'review', reasons: ['queued for review'] };
  },
};
