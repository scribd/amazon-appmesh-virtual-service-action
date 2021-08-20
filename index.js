const core = require('@actions/core');
const {AppMeshClient, CreateVirtualServiceCommand, DeleteVirtualServiceCommand, DescribeVirtualServiceCommand} = require('@aws-sdk/client-app-mesh');
const _ = require('lodash');


/**
 *
 * ERRORS
 * Provides signals for controlling application behavior.
 *
 *****************************************************************************************/

/**
 * An error type representing a failure to find a service
 * @extends Error
 */
class NotFoundException extends Error {
  /**
   * @param {String} message Error message
   */
  constructor(message) {
    super(message);
    this.name = 'NotFoundException';
    this.message = message;
    this.stack = (new Error()).stack;
  }
}


/**
 *
 * PARAMETER CONVERSION
 * Converts the supplied (create) parameters into the formats for describe, update, and delete.
 *
 *****************************************************************************************/

/**
 * return only defined properties
 * @param {Object} obj
 * @return {Object} sans keynames with 'undefined' values'
 */
function omitUndefined(obj) {
  return _.pickBy(obj, (value, key) => {
    return value !== undefined;
  });
}

/**
 * Filter parameters according to createGatewayRoute API
 * @param {Object} parameters Original parameters
 * @return {Object} Filtered parameters
 */
function createInput(parameters) {
  return omitUndefined(
      {
        ...describeInput(parameters),
        spec: parameters.spec,
      },
  );
}

/**
 * Filter parameters according to describeGatewayRoute API
 * @param {Object} parameters Original parameters
 * @return {Object} Filtered parameters
 */
function describeInput(parameters) {
  return omitUndefined(
      {
        virtualServiceName: parameters.virtualServiceName,
        meshName: parameters.meshName,
        meshOwner: parameters.meshOwner,
      },
  );
}

/**
 * Filter parameters according to deleteGatewayRoute API
 * @param {Object} parameters Original parameters
 * @return {Object} Filtered parameters
 */
function deleteInput(parameters) {
  return omitUndefined(
      {
        ...describeInput(parameters),
      },
  );
}


/**
/**
 *
 * Custom Waiter
 * Create a custom waiter while the SDK doesn't have one built in yet.
 *
 *****************************************************************************************/

const {WaiterState, checkExceptions, createWaiter} = require('@aws-sdk/util-waiter');

const checkState = async (client, parameters) => {
  let response;
  let status;

  try {
    core.info('... polling resource...');
    response = await describeResource(client, describeInput(parameters));
    status = response.virtualServer.status.status;
  } catch (err) {
    if (err.name == 'NotFoundException') {
      core.info('... and it is missing ...');
      status = 'MISSING';
    } else {
      throw err;
    }
  }

  if (status == 'MISSING') {
    return {state: WaiterState.SUCCESS, response};
  }
  if (status == 'DELETED') {
    return {state: WaiterState.SUCCESS, response};
  }
  return {state: WaiterState.RETRY, response};
};

async function waitUntilResourceDeleted(client, parameters) {
  core.info('Waiting for resource to be deleted...');
  const serviceDefaults = {minDelay: 15, maxDelay: 120};
  const result = await createWaiter({...serviceDefaults, ...client}, parameters, checkState);
  core.info('...done waiiting for resource to be deleted.');
  return checkExceptions(result);
};


/**
 * AWS CALLS
 * Take the supplied parameters and send them to AWS
 *
 *****************************************************************************************/


/**
 * Fetch Service or throw an error
 * @param {@aws-sdk/client-app-mesh/AppMeshClient} client client
 * @param {Object} parameters Parameters describing the Service
 * @return {Promise} that resolves to {@aws-sdk/client-app-mesh/DescribeVirtualServiceCommandOutput}
 */
async function describeResource(client, parameters) {
  const command = new DescribeVirtualServiceCommand(describeInput(parameters));
  const response = await client.send(command);
  return response;
}

/**
 * Create Service or throw an error
 * @param {@aws-sdk/client-app-mesh/AppMeshClient} client client
 * @param {Object} parameters Parameters describing the Service
 * @return {Promise} that resolves to {@aws-sdk/client-app-mesh/CreateVirtualServiceCommandOutput}
 */
async function createResource(client, parameters) {
  const command = new CreateVirtualServiceCommand(createInput(parameters));
  const response = await client.send(command);
  return response;
}

/**
 * Delete Service or throw an error
 * @param {@aws-sdk/client-app-mesh/AppMeshClient} client client
 * @param {Object} parameters Parameters describing the Service
 * @return {Promise} that resolves to {@aws-sdk/client-app-mesh/deleteVirtualServiceCommandOutput}
 */
async function deleteResource(client, parameters) {
  const command = new DeleteVirtualServiceCommand(deleteInput(parameters));
  const response = await client.send(command);
  return response;
}


/**
 *
 * FIND/CREATE/DELETE BUSINESS LOGIC
 *
 *****************************************************************************************/

/**
 * Find or create the Service
 * @param {@aws-sdk/client-app-mesh/AppMeshClient} client client
 * @param {Object} parameters Parameters describing the Service
 * @return {Promise} that resolves to {@aws-sdk/client-app-mesh/DescribeVirtualServiceCommandOutput} or {@aws-sdk/client-app-mesh/CreateVirtualServiceCommandOutput}
 */
async function findOrCreate(client, parameters) {
  core.info(`Searching for ${parameters.virtualServiceName}`);
  try {
    const response = await describeResource(client, parameters);
    if (response && response.virtualService) {
      switch (response.virtualService.status.status) {
        case 'ACTIVE':
          core.info(`${response.virtualService.virtualServiceName} found.`);
          return response;
        case 'INACTIVE':
          core.warn(`${response.virtualService.virtualServiceName} found, but it is INACTIVE.`);
          return response;
        case 'DELETED':
          const message = `${parameters.virtualServiceName} found, but it is DELETED.`;
          throw new NotFoundException(message);
        default:
          throw new Error(response);
      }
    } else {
      throw new Error(`Invalid response from describeResource: ${JSON.stringify(response)}`);
    }
  } catch (err) {
    if (err.name === 'NotFoundException') {
      core.info(`Unable to find ${parameters.virtualServiceName}. Creating newly.`);
      return await createResource(client, parameters);
    }
    throw err;
  }
}


/**
 *
 * GITHUB ACTIONS INTERFACE
 * - Gets parameters from the user.
 * - Posts results as output.
 *
 *****************************************************************************************/

/**
 * @param {Error} err The original error
 * @param {String} param The parameter that was being evaluated
 * @param {String} s The supplied string
 * @return {Error} The Error indicating invalid JSON, if JSON, else err.
 */
function handleGetParameterErrors(err, param, s) {
  if (err instanceof SyntaxError) {
    return new Error(`Invalid JSON for ${param}: ${err.message}: ${s}`);
  } else {
    return err;
  }
}

/**
 * Fetch parameters from environment
 * @return {Promise} that resolves to {@aws-sdk/client-app-mesh/DescribeVirtualServiceCommandOutput} or {@aws-sdk/client-app-mesh/CreateVirtualServiceCommandOutput}
 */
function getParameters() {
  const parameters = {
    action: core.getInput('action', {required: false}) || 'create',
    meshOwner: core.getInput('mesh-owner', {required: false}),
    meshName: core.getInput('mesh-name', {required: true}),
    virtualServiceName: core.getInput('name', {required: true}),
  };

  // JSON Parameters
  Object.entries({
    spec: 'spec',
    tags: 'tags',
  }).forEach(([key, value]) => {
    const s = core.getInput(value, {required: false});
    if (s) {
      let t;
      try {
        t = JSON.parse(s);
      } catch (err) {
        throw handleGetParameterErrors(err, key, s);
      }
      Object.assign(parameters, {[key]: t});
    }
  });

  return _.pickBy(
      parameters,
      (value, key) => {
        return value !== '';
      },
  );
}

/**
 * Posts the results of the action to GITHUB_ENV
 * @param {Object} response Response response
 */
function postToGithub(response) {
  let arn;
  if (response.virtualService && response.virtualService.metadata) {
    arn = response.virtualService.metadata.arn;
  } else {
    throw new Error('Unable to determine ARN');
  }
  core.info('ARN found, created, or deleted: ' + arn);
  core.setOutput('response', response);
  core.setOutput('arn', arn);
}


/**
 *
 * ENTRYPOINT
 *
 *****************************************************************************************/

/**
 * Executes the action
 * @return {Promise} that resolves to {@aws-sdk/client-app-mesh/DescribeVirtualServiceCommandOutput} or {@aws-sdk/client-app-mesh/CreateVirtualServiceCommandOutput}
 */
async function run() {
  const client = new AppMeshClient({
    customUserAgent: 'amazon-appmesh-virtual-service-for-github-actions',
  });

  client.middlewareStack.add((next, context) => (args) => {
    core.debug(`Middleware sending ${context.commandName} to ${context.clientName} with: ${JSON.stringify(args)}`);

    return next(args);
  },
  {
    step: 'build',
  },
  );

  // Get input parameters
  const parameters = getParameters();
  let response;
  if (parameters.action == 'delete') {
    response = await deleteResource(client, parameters);
    await waitUntilResourceDeleted({client, maxWaitTime: 300}, parameters);
  } else {
    response = await findOrCreate(client, parameters);
  }

  postToGithub(response);
  return response;
}

/* istanbul ignore next */
if (require.main === module) {
  run().catch((err) => {
    core.debug(`Received error: ${JSON.stringify(err)}`);
    const httpStatusCode = err.$metadata ? err.$metadata.httpStatusCode : undefined;
    core.setFailed(`${err.name} (Status code: ${httpStatusCode}): ${err.message}`);
    core.debug(err.stack);
    process.exit(1);
  });
}

/* For testing */
module.exports = {
  createInput,
  createResource,
  findOrCreate,
  deleteInput,
  deleteResource,
  describeInput,
  describeResource,
  getParameters,
  postToGithub,
  run,
};
