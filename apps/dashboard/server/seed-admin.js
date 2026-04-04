import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';

// Block client-side account creation — admin is seeded server-side only
Accounts.config({ forbidClientAccountCreation: true });

Meteor.startup(async () => {
  const username = Meteor.settings?.adminUsername || 'admin';
  const password = Meteor.settings?.adminPassword || 'admin1234!';

  const existing = await Meteor.users.findOneAsync({ username });

  if (!existing) {
    await Accounts.createUserAsync({ username, password });
    console.log(`[seed-admin] Created admin user "${username}"`);
  } else {
    // Update password if settings changed
    await Accounts.setPasswordAsync(existing._id, password);
    console.log(`[seed-admin] Admin user "${username}" exists, password synced from settings`);
  }
});
