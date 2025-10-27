import React, { useCallback, useRef } from 'react';
import { useFind, useSubscribe } from 'meteor/react-meteor-data';
import { LinksCollection } from '../api/links';
import { context, SpanStatusCode } from '@opentelemetry/api';
import { Meteor } from 'meteor/meteor';
import { startUiInsertSpan } from '../clients/links-otel';
import { Random } from 'meteor/random';


export const Info = () => {
  const isLoading = useSubscribe('links');
  const links = useFind(() => LinksCollection.find());
  const sessionIdRef = useRef(Random.id());

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const { span, context: activeCtx, carrier } = startUiInsertSpan();
    const createdAt = new Date();
    span.setAttribute('links.session_id', sessionIdRef.current);
    span.setAttribute('links.created_at_iso', createdAt.toISOString());

    try {
      await context.with(activeCtx, () =>
        Meteor.callAsync('links.insert', {
          carrier,
          sessionId: sessionIdRef.current,
          createdAt,
        }),
      );
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      if (err instanceof Error) {
        span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });
        console.error('links.insert failed', err);
      } else {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'links.insert failed',
        });
        console.error('links.insert failed', err);
      }
    } finally {
      span.end();
    }
  }, []);


  const loading = isLoading();

  const onClear = () => {
    Meteor.call('links.clear', (err) => {
      if (err) {
        console.error('Clear failed', err);
        return;
      }
    });
  };

  const onClearMine = () => {
    Meteor.call('links.clearSession', sessionIdRef.current, (err) => {
      if (err) {
        console.error('Clear session failed', err);
      }
    });
  };

  return (
    <div>
      <h2>Learn Meteor!</h2>
      {loading ? (
        <div>Loading...</div>
      ) : (
        <>
          <p><strong>Session ID:</strong> {sessionIdRef.current}</p>
          <form onSubmit={onSubmit} style={{marginBottom: '1rem'}}>
            <button type="submit" data-testid='add-item'>addTask</button>
            <button type="button" onClick={onClear} style={{marginLeft: '1rem', background: '#e74c3c', color: '#fff'}}>EraseDB</button>
            <button
              type="button"
              onClick={onClearMine}
              style={{marginLeft: '1rem', background: '#2980b9', color: '#fff'}}
            >
              EraseSession
            </button>
          </form>
          <ul>{links.map(
            link => <li key={link._id}>
              <span>
                <strong>ID:</strong> {link._id} | <strong>createdAt:</strong> {link.createdAt ? new Date(link.createdAt).toLocaleString() : 'N/A'} | <strong>session:</strong> {link.sessionId ?? 'N/A'}
              </span>
            </li>
          )}</ul>
        </>
      )}
    </div>
  );
};
