const registerActivityExample = {
  activityId: '6D56B540-30F0-4B4A-9D78-7EE9802A741D',
  pushToken: 'abcdef1234567890',
  courseName: '資料庫系統',
  courseId: 'CS401',
  classStartDate: 1760000400,
  classEndDate: 1760007600
};

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Apple Server API',
    version: '1.0.0',
    description: 'Express TypeScript server for ActivityKit Live Activity APNs updates.'
  },
  servers: [
    {
      url: '/',
      description: 'Current server'
    }
  ],
  tags: [
    {
      name: 'Activities',
      description: 'Live Activity registration and inspection endpoints.'
    }
  ],
  paths: {
    '/activities': {
      get: {
        tags: ['Activities'],
        summary: 'List registered activities',
        description: 'Returns all current in-memory registrations with redacted token previews.',
        responses: {
          '200': {
            description: 'Current activity registrations.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['activities'],
                  properties: {
                    activities: {
                      type: 'array',
                      items: {
                        $ref: '#/components/schemas/ActivityListItem'
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/activity/register': {
      post: {
        tags: ['Activities'],
        summary: 'Register or replace a Live Activity',
        description: 'Registers or replaces a single Live Activity entry in the in-memory store.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/RegisterActivityPayload'
              },
              example: registerActivityExample
            }
          }
        },
        responses: {
          '201': {
            description: 'Live Activity registered successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/RegisterActivityResponse'
                }
              }
            }
          },
          '400': {
            description: 'Validation failed for the request body.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                },
                examples: {
                  invalidBody: {
                    value: {
                      error: 'Request body must contain exactly these fields: activityId, pushToken, courseName, courseId, classStartDate, classEndDate'
                    }
                  },
                  invalidScheduleWindow: {
                    value: {
                      error: 'classStartDate and classEndDate must be within 24.8 days of the current server time.'
                    }
                  },
                  invalidToken: {
                    value: {
                      error: 'pushToken must be a hex-encoded string.'
                    }
                  }
                }
              }
            }
          },
          '500': {
            description: 'Unexpected server error.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    },
    '/activity/{activityId}': {
      delete: {
        tags: ['Activities'],
        summary: 'Delete a registered Live Activity',
        description: 'Deletes a registration and cancels pending timers.',
        parameters: [
          {
            name: 'activityId',
            in: 'path',
            required: true,
            description: 'The ActivityKit activity identifier.',
            schema: {
              type: 'string'
            }
          }
        ],
        responses: {
          '204': {
            description: 'Registration deleted successfully.'
          },
          '404': {
            description: 'No registration exists for the provided activity ID.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                },
                example: {
                  error: 'Activity not found.'
                }
              }
            }
          },
          '500': {
            description: 'Unexpected server error.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      ActivityPhase: {
        type: 'string',
        enum: ['before', 'during', 'ended']
      },
      RegisterActivityPayload: {
        type: 'object',
        additionalProperties: false,
        required: ['activityId', 'pushToken', 'courseName', 'courseId', 'classStartDate', 'classEndDate'],
        properties: {
          activityId: {
            type: 'string',
            minLength: 1,
            pattern: '.*\\S.*',
            description: 'ActivityKit activity identifier.'
          },
          pushToken: {
            type: 'string',
            minLength: 2,
            pattern: '^(?:[0-9a-fA-F]{2})+$',
            description: 'Hex-encoded Live Activity push token with an even number of characters.'
          },
          courseName: {
            type: 'string',
            minLength: 1,
            pattern: '.*\\S.*'
          },
          courseId: {
            type: 'string',
            minLength: 1,
            pattern: '.*\\S.*'
          },
          classStartDate: {
            type: 'integer',
            minimum: 1,
            description: 'Unix timestamp in seconds and must be within 24.8 days of the current server time.'
          },
          classEndDate: {
            type: 'integer',
            minimum: 1,
            description: 'Unix timestamp in seconds, must be greater than classStartDate, and must be within 24.8 days of the current server time.'
          }
        },
        example: registerActivityExample
      },
      RegisterActivityResponse: {
        type: 'object',
        required: ['activityId', 'currentPhase', 'classStartDate', 'classEndDate'],
        properties: {
          activityId: {
            type: 'string'
          },
          currentPhase: {
            $ref: '#/components/schemas/ActivityPhase'
          },
          classStartDate: {
            type: 'integer'
          },
          classEndDate: {
            type: 'integer'
          }
        }
      },
      ActivityListItem: {
        type: 'object',
        required: [
          'activityId',
          'pushTokenPreview',
          'courseName',
          'courseId',
          'classStartDate',
          'classEndDate',
          'currentPhase',
          'createdAt',
          'updatedAt'
        ],
        properties: {
          activityId: {
            type: 'string'
          },
          pushTokenPreview: {
            type: 'string'
          },
          courseName: {
            type: 'string'
          },
          courseId: {
            type: 'string'
          },
          classStartDate: {
            type: 'integer'
          },
          classEndDate: {
            type: 'integer'
          },
          currentPhase: {
            $ref: '#/components/schemas/ActivityPhase'
          },
          createdAt: {
            type: 'integer'
          },
          updatedAt: {
            type: 'integer'
          }
        }
      },
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'string'
          }
        }
      }
    }
  }
} as const;
