/* dropbox object key naming convention violates eslint's camelcase */
/* eslint camelcase:off */
const list_folder_single = require('./files$list_folder');
const list_folder_big = require('./files$list_folder_big.json');
const list_folder$continue_1 = require('./files$list_folder$continue_1.json');
const list_folder$continue_2 = require('./files$list_folder$continue_2.json');
const list_folder$continue_3 = require('./files$list_folder$continue_3.json');
const list_folder$continue_4 = require('./files$list_folder$continue_4.json');
const list_folder$continue_5 = require('./files$list_folder$continue_5.json');
const list_folder$continue_6 = require('./files$list_folder$continue_6.json');
const list_folder$continue_7 = require('./files$list_folder$continue_7.json');
const list_folder$continue_8 = require('./files$list_folder$continue_8.json');
const list_folder$continue_9 = require('./files$list_folder$continue_9_empty.json');

module.exports.dropbox = {
  authInfo: {
    access_token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    token_type: 'bearer',
    uid: 12345678,
    account_id: 'dbid:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  },
  responses: {
    users$get_account: {
      account_id: 'dbid:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      name: {
        given_name: 'John',
        surname: 'Doe',
        familiar_name: 'John',
        display_name: 'John Doe'
      },
      email: 'john.doe@gmail.com',
      email_verified: true,
      disabled: false,
      is_teammate: true
    },
    users$get_account_fail: {
      account_id: 'dbid:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      name: {
        given_name: 'John',
        surname: 'Doe',
        familiar_name: 'John',
        display_name: 'John Doe'
      },
      email: 'john.doe@gmail.com',
      email_verified: false,
      disabled: false,
      is_teammate: true
    },
    files$list_folder: list_folder_single,
    files$list_folder_big: list_folder_big,
    files$list_folder$cont: [
      list_folder$continue_1,
      list_folder$continue_2,
      list_folder$continue_3,
      list_folder$continue_4,
      list_folder$continue_5,
      list_folder$continue_6,
      list_folder$continue_7,
      list_folder$continue_8,
      list_folder$continue_9
    ]
  }
};

module.exports.fs = {

};
