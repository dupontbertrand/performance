import React, { useCallback, useRef } from 'react';
import { useFind, useSubscribe } from 'meteor/react-meteor-data';
import { LinksCollection } from '../api/links';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';


export const Info = () => {
  const isLoading = useSubscribe('links');
  const links = useFind(() => LinksCollection.find());
  const sessionIdRef = useRef(Random.id());

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const createdAt = new Date();
    try {
      await Meteor.callAsync('links.insert', {
        sessionId: sessionIdRef.current,
        createdAt,
      });
    } catch (err) {
      console.error('links.insert failed', err);
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
          <form onSubmit={onSubmit} style={{ marginBottom: '1rem' }}>
            <button type="submit" data-testid='add-item'>addTask</button>
            <button type="button" onClick={onClear} style={{ marginLeft: '1rem', background: '#e74c3c', color: '#fff' }}>EraseDB</button>
            <button
              type="button"
              onClick={onClearMine}
              style={{ marginLeft: '1rem', background: '#2980b9', color: '#fff' }}
            >
              EraseSession
            </button>
          </form>
          <ul>{links.map(
            link => {
              // console.log(link)
              const strId = typeof link._id === 'object' ? link._id.toHexString() : link._id;
              return (
                <li key={strId}>
                  <span>
                    <strong>ID:</strong> {strId} | <strong>createdAt:</strong> {link.createdAt ? new Date(link.createdAt).toLocaleString() : 'N/A'} | <strong>session:</strong> {link.sessionId ?? 'N/A'}
                  </span>
                </li>
              );
            }
          )}</ul>
        </>
      )}
    </div>
  );
};
