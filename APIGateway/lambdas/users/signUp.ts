import { lambda, sdk } from '@pulumi/aws';

import type { CUser, IUser } from '#tables/tables/user';
import type { lambdaEvent } from '#utils/util';

import { UsersTable } from '#tables/index';
import { validateUserBody } from '#tables/validation/users';
import {
  deconstruct,
  currentEndpoint,
  CUSTOM_ERROR_CODES,
  makeCustomError,
  STATUS_CODES,
  pascalCase,
  cryptoEncrypt,
  generateFlake,
  userEpoch,
  jwtSign,
  populateResponse,
} from '#utils/util';

/**
 * The signout lambda
 * @description
 * - The lambda is used to sign out a user
 * - The lambda is triggered by a POST request to /users/signout
 *
 * @see https://www.pulumi.com/docs/guides/crosswalk/aws/api-gateway/#lambda-request-handling
 */
export const signUp = new lambda.CallbackFunction<
  lambdaEvent,
  {
    body: string;
    statusCode: number;
  }
>('signUp', {
  runtime: lambda.Runtime.NodeJS16dX,
  callback: async event => {
    const { error, parsed } = validateUserBody(event, { email: true, password: true, name: true, tags: true });

    if (!parsed || error) {
      return populateResponse(
        STATUS_CODES.INTERNAL_SERVER_ERROR,
        makeCustomError(error ?? 'Bad Request', CUSTOM_ERROR_CODES.BODY_NOT_VALID),
      );
    }

    const { email, password, name, tags } = parsed as IUser & Pick<CUser, 'email' | 'name' | 'password' | 'tags'>;
    const id = generateFlake(Date.now(), userEpoch);

    try {
      const token = jwtSign(id, email);
      const user: IUser = {
        name: pascalCase(name),
        tags,
        userID: id,
        email,
        password: cryptoEncrypt(password),
        token: cryptoEncrypt(token),
      };
      const client = new sdk.DynamoDB.DocumentClient(currentEndpoint);
      await client
        .put({
          TableName: UsersTable.get(),
          Item: user,
          ConditionExpression: 'attribute_not_exists(email) AND attribute_not_exists(userID)',
        })
        .promise();

      delete user.token;
      delete user.password;
      const { timestamp } = deconstruct(id, userEpoch);
      return populateResponse(STATUS_CODES.OK, { ...user, token, createdAt: timestamp });
    } catch (error) {
      if ((error as any).code === 'ConditionalCheckFailedException') {
        return populateResponse(
          STATUS_CODES.INTERNAL_SERVER_ERROR,
          makeCustomError('User with that email already exists', CUSTOM_ERROR_CODES.USER_ALREADY_EXISTS),
        );
      }

      console.error(error);
      return populateResponse(
        STATUS_CODES.INTERNAL_SERVER_ERROR,
        makeCustomError('Internal Server Error', CUSTOM_ERROR_CODES.USER_ERROR),
      );
    }
  },
});
