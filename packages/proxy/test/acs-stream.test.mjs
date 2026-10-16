import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import { ACS_PATH, activeContractsOverWebSocket, isAcsListLimit } from '../dist/acs-stream.js';
import {
  classifyOfferConsumption,
  holdingMatchesInstrument,
  participantUpdateConsumesWith,
} from '../dist/v1-lane.js';

const LIMIT_BODY = '{"code":"JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED","cause":"201 > 200"}';

test('only the active-contracts list-limit 413 triggers the stream fallback', () => {
  assert.equal(isAcsListLimit(413, ACS_PATH, LIMIT_BODY), true);
  assert.equal(isAcsListLimit(413, '/v2/updates/flats', LIMIT_BODY), false);
  assert.equal(isAcsListLimit(400, ACS_PATH, LIMIT_BODY), false);
  assert.equal(isAcsListLimit(413, ACS_PATH, '{"code":"SOMETHING_ELSE"}'), false);
});

async function withServer(onRequest, fn) {
  const wss = new WebSocketServer({ port: 0, path: ACS_PATH, handleProtocols: () => 'daml.ws.auth' });
  wss.on('connection', (socket) => socket.once('message', (data) => onRequest(socket, JSON.parse(String(data)))));
  await new Promise((r) => wss.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${wss.address().port}`);
  } finally {
    await new Promise((r) => wss.close(r));
  }
}

const row = (cid) => ({ contractEntry: { JsActiveContract: { createdEvent: { contractId: cid } } }, workflowId: '' });

test('streams the full snapshot past the HTTP cap', async () => {
  const request = { filter: { filtersByParty: {} }, activeAtOffset: 7 };
  const rows = await withServer(
    (socket, received) => {
      assert.deepEqual(received, request);
      for (let i = 0; i < 250; i++) socket.send(JSON.stringify(row(`cid-${i}`)));
      socket.close(1000);
    },
    (url) => activeContractsOverWebSocket(url, undefined, request),
  );
  assert.equal(rows.length, 250);
  assert.equal(rows[249].contractEntry.JsActiveContract.createdEvent.contractId, 'cid-249');
});

test('an error frame rejects instead of returning partial rows', async () => {
  await assert.rejects(
    withServer(
      (socket) => {
        socket.send(JSON.stringify(row('cid-0')));
        socket.send(JSON.stringify({ code: 'PERMISSION_DENIED', cause: 'no read rights' }));
      },
      (url) => activeContractsOverWebSocket(url, undefined, {}),
    ),
    /PERMISSION_DENIED/,
  );
});

test('an abnormal close rejects instead of returning partial rows', async () => {
  await assert.rejects(
    withServer(
      (socket) => {
        socket.send(JSON.stringify(row('cid-0')));
        socket.close(1011, 'internal error');
      },
      (url) => activeContractsOverWebSocket(url, undefined, {}),
    ),
    /closed with code 1011/,
  );
});

test('a registry holding counts only toward its own instrument', () => {
  const usdcx = { id: 'USDCx', admin: 'usdc-rep::1220aa' };
  const holding = (id, source) => ({ owner: 'P::1', amount: '5', instrument: { source, id, scheme: 'RegistrarInternalScheme' } });
  assert.equal(holdingMatchesInstrument(holding('USDCx', 'usdc-rep::1220aa'), usdcx), true);
  assert.equal(holdingMatchesInstrument(holding('NOVA', 'NOVA-Admin::1220bb'), usdcx), false);
  assert.equal(holdingMatchesInstrument(holding('USDCx', 'Impostor::1220cc'), usdcx), false);
});

test('an Amulet holding has no instrument field and is identified by its template', () => {
  assert.equal(
    holdingMatchesInstrument({ owner: 'P::1', amount: { initialAmount: '5' } }, { id: 'Amulet', admin: 'DSO::1' }),
    true,
  );
});

const txUpdate = (events) => ({ update: { Transaction: { value: { updateId: 'u1', events } } } });
const exercise = (contractId, choice, consuming = true) => ({ ExercisedEvent: { contractId, choice, consuming } });
const WITHDRAW = 'TransferInstruction_Withdraw';

test('a withdraw is confirmed by the consuming withdraw choice on the tracked offer', () => {
  const withdraw = txUpdate([exercise('offer-cid', WITHDRAW), exercise('holding', 'Archive')]);
  assert.equal(participantUpdateConsumesWith(withdraw, 'offer-cid', WITHDRAW), true);
  assert.equal(participantUpdateConsumesWith(withdraw, 'other-offer', WITHDRAW), false);
});

test('an accept consumes the same offer but is not a withdraw', () => {
  const accept = txUpdate([exercise('offer-cid', 'TransferInstruction_Accept')]);
  assert.equal(participantUpdateConsumesWith(accept, 'offer-cid', WITHDRAW), false);
});

test('a non-consuming exercise on the offer is not a withdraw', () => {
  const peek = txUpdate([exercise('offer-cid', WITHDRAW, false)]);
  assert.equal(participantUpdateConsumesWith(peek, 'offer-cid', WITHDRAW), false);
});

test("the offer's own creation does not count as its withdrawal", () => {
  const creation = txUpdate([{ CreatedEvent: { contractId: 'offer-cid' } }]);
  assert.equal(participantUpdateConsumesWith(creation, 'offer-cid', WITHDRAW), false);
});

test('a malformed update confirms nothing', () => {
  assert.equal(participantUpdateConsumesWith(undefined, 'offer-cid', WITHDRAW), false);
  assert.equal(participantUpdateConsumesWith({ update: {} }, 'offer-cid', WITHDRAW), false);
});

const consumedBy = (choice) => txUpdate([exercise('offer-cid', choice)]);

test('an accepted offer is classified as delivered, with its update id', () => {
  assert.deepEqual(classifyOfferConsumption(consumedBy('TransferInstruction_Accept'), 'offer-cid'), {
    kind: 'accepted',
    updateId: 'u1',
  });
});

test('a withdrawn or rejected offer returned the funds', () => {
  for (const choice of ['TransferInstruction_Withdraw', 'TransferInstruction_Reject']) {
    assert.equal(classifyOfferConsumption(consumedBy(choice), 'offer-cid').kind, 'returned');
  }
});

test('an unrecognised consumption is unknown rather than guessed', () => {
  assert.equal(classifyOfferConsumption(consumedBy('TransferInstruction_Update'), 'offer-cid').kind, 'unknown');
  assert.equal(classifyOfferConsumption(txUpdate([]), 'offer-cid').kind, 'unknown');
});
