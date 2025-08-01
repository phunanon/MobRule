import assert from 'assert';
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { Client, Guild, Interaction, MessageFlags } from 'discord.js';
import { ApplicationCommandOptionType, ButtonInteraction } from 'discord.js';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder } from 'discord.js';
import { ButtonStyle, CacheType, EmbedBuilder } from 'discord.js';
import { GatewayIntentBits, IntentsBitField, Partials } from 'discord.js';

export const prisma = new PrismaClient();

export const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel],
});

const HasHigherRoleThanMe = async (userId: string, guild: Guild) => {
  const me = await guild.members.fetchMe();
  const them = await guild.members.fetch(userId);
  if (!me.roles.highest) return false;
  if (!them.roles.highest) return false;
  if (them.roles.highest.position <= me.roles.highest.position) return false;
  return true;
};

type User = { sf: BigInt; tag: string; staff: boolean };
const makeFields = (approved: boolean, users: User[]) => [
  {
    name: 'Staff approved?',
    value: approved ? 'Yes' : 'Not yet',
    inline: true,
  },
  {
    name: `Supporters (${users.length}/3)`,
    value: users
      .map(
        ({ sf, tag, staff }) =>
          `${staff ? ':shield: ' : ''}<@${sf}> (\`${tag}\`)`,
      )
      .join('\n'),
    inline: true,
  },
];

const isExecutable = <T>(approved: boolean, users: T[]) =>
  approved && users.length >= 3;

const makeEmbed = (
  plaintiffSf: BigInt,
  defendantSf: BigInt,
  reason: string,
  approved: boolean,
  users: User[],
) => {
  const executed = isExecutable(approved, users);
  const has = executed ? '' : 'has ';
  const icon = new AttachmentBuilder('mob.png');
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Server ban proposal' + (executed ? ' successful' : ''))
        .setDescription(
          `<@${plaintiffSf}> ${has}proposed <@${defendantSf}> be banned. Reason:
> ${reason}`,
        )
        .setFields(makeFields(approved, users))
        .setThumbnail('attachment://mob.png')
        .setColor('Red'),
    ],
    files: [icon],
  };
};

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.id}`);

  void client.application?.commands.create({
    name: 'propose-ban',
    description: 'Propose that somebody should be banned from the server.',
    options: [
      {
        name: 'who',
        type: ApplicationCommandOptionType.User,
        description: 'The user to be banned',
        required: true,
      },
      {
        name: 'reason',
        type: ApplicationCommandOptionType.String,
        description: 'The reason for the ban proposal',
        required: true,
        minLength: 4,
      },
    ],
  });

  async function HandleInteraction(interaction: Interaction) {
    if (!interaction.guildId || !interaction.guild || !interaction.member)
      return;

    const guildSf = BigInt(interaction.guildId);
    const plaintiff = interaction.user;
    const plaintiffSf = BigInt(plaintiff.id);
    const aboveMe = await HasHigherRoleThanMe(plaintiff.id, interaction.guild);

    if (interaction.isButton())
      await HandleButton(interaction, guildSf, aboveMe);
    if (!interaction.isCommand()) return;
    if (interaction.commandName !== 'propose-ban') return;
    await interaction.deferReply();

    //Check the plaintiff can make another proposal right now
    //- Staff can make 3 proposals every 1h, others can make 1 every 24h
    const proposalsWindowMs = aboveMe ? 60 * 60_000 : 24 * 60 * 60_000;
    const windowStartMs = new Date(Date.now() - proposalsWindowMs);
    const maxNumProposalsInWindow = aboveMe ? 3 : 1;
    const numProposals = await prisma.proposal.count({
      where: { guildSf, plaintiffSf, at: { gte: windowStartMs } },
    });
    if (numProposals >= maxNumProposalsInWindow) {
      const plural = numProposals === 1 ? '' : 's';
      const window = aboveMe ? 'hour' : '24 hours';
      await interaction.editReply(
        `You have already made ${numProposals} proposal${plural} in the past ${window}.`,
      );
      return;
    }

    const defendant = interaction.options.get('who', true)?.user;
    if (!defendant) {
      await interaction.editReply('Could not find the user you specified.');
      return;
    }
    const defendantSf = BigInt(defendant.id);

    if (plaintiffSf == defendantSf)
      return await interaction.editReply('You cannot propose to ban yourself.');

    if (await HasHigherRoleThanMe(defendant.id, interaction.guild))
      return await interaction.editReply(
        'You cannot propose to ban a staff user.',
      );

    const reason = `${interaction.options.get('reason', true)?.value}`;

    const voterTag = plaintiff.tag;
    const proposal = await prisma.proposal.create({
      data: {
        ...{ guildSf, plaintiffSf, defendantSf, reason },
        votes: { create: { voterSf: plaintiffSf, voterTag, staff: aboveMe } },
      },
    });

    const expiresAtSec = Math.ceil(Date.now() / 1000) + 24 * 60 * 60;
    await interaction.editReply({
      content: `Expires <t:${expiresAtSec}:R>`,
      ...makeEmbed(plaintiffSf, defendantSf, reason, aboveMe, [
        { sf: plaintiffSf, tag: voterTag, staff: aboveMe },
      ]),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`vote-${proposal.id}`)
            .setLabel('Support the proposal')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
  }

  client.on('interactionCreate', async interaction => {
    try {
      await HandleInteraction(interaction);
    } catch (err) {
      console.error(err);
      if (interaction.isRepliable())
        await interaction.editReply(
          'An error occurred while processing your request.',
        );
    }
  });
});

async function HandleButton(
  interaction: ButtonInteraction<CacheType>,
  guildSf: bigint,
  staff: boolean,
) {
  const proposalId = Number(interaction.customId.split('-')[1]);
  if (
    Number.isNaN(proposalId) ||
    proposalId <= 0 ||
    !Number.isFinite(proposalId) ||
    proposalId !== Math.floor(proposalId)
  ) {
    return await interaction.reply({
      content: 'Invalid proposal.',
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferUpdate();
  const proposal = await prisma.proposal.findFirst({
    where: { id: proposalId, guildSf },
    include: { votes: true },
  });
  if (!proposal) {
    return await interaction.followUp({
      content: 'Proposal not found.',
      flags: MessageFlags.Ephemeral,
    });
  }

  //Check if it has expired
  const expiresAt = new Date(proposal.at.getTime() + 24 * 60 * 60_000);
  if (expiresAt < new Date()) {
    const expiresAtSec = Math.ceil(expiresAt.getTime() / 1000);
    return await interaction.followUp({
      content: `This proposal expired <t:${expiresAtSec}:R>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  //If not staff, check if they have already voted in the past 24h
  const voterSf = BigInt(interaction.user.id);
  if (!staff) {
    const votesWindowMs = 24 * 60 * 60_000;
    const windowStartMs = new Date(Date.now() - votesWindowMs);
    const [vote] = await prisma.vote.findMany({
      where: { proposalId, voterSf, at: { gte: windowStartMs } },
    });
    if (vote) {
      const anotherAfterSec = Math.ceil(
        (vote.at.getTime() + votesWindowMs) / 1000,
      );
      return await interaction.followUp({
        content: `You have already voted in the past 24 hours. You can vote again <t:${anotherAfterSec}:R>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  //Check if the user has already voted
  const alreadyVoted = proposal.votes.some(v => v.voterSf === voterSf);
  if (alreadyVoted) {
    return await interaction.followUp({
      content: 'You have already voted on this proposal.',
      flags: MessageFlags.Ephemeral,
    });
  }

  //Update the message
  const voterTag = interaction.user.tag;
  const approved = proposal.votes.some(v => v.staff) || staff;
  const users = [
    ...proposal.votes.map(v => ({
      sf: v.voterSf,
      tag: v.voterTag,
      staff: v.staff,
    })),
    { sf: voterSf, tag: voterTag, staff },
  ];
  const { plaintiffSf, defendantSf, reason } = proposal;
  const executed = isExecutable(approved, users);
  await interaction.message.edit({
    content: executed
      ? `<@${defendantSf}> was banned <t:${Math.ceil(Date.now() / 1000)}:R>.`
      : interaction.message.content,
    ...makeEmbed(plaintiffSf, defendantSf, reason, approved, users),
    components: executed ? [] : undefined,
  });

  await prisma.vote.create({ data: { proposalId, voterSf, voterTag, staff } });

  await interaction.followUp({
    content: 'Your vote has been recorded.',
    flags: MessageFlags.Ephemeral,
  });

  if (executed) {
    // If the proposal has been executed, ban the user
    const guild = await client.guilds.fetch(guildSf.toString());
    if (!guild) return;

    try {
      const defendant = await guild.members.fetch(defendantSf.toString());
      await defendant.ban({ reason: `${interaction.message.url}: ${reason}` });
      console.log(`Banned ${defendant.user.tag} (${defendantSf})`);
    } catch (err) {
      console.error(`Failed to ban user ${defendantSf}:`, err);
    }
  }
}

assert(
  process.env.DISCORD_TOKEN,
  'DISCORD_TOKEN must be set in environment variables',
);
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err);
  process.exit(1);
});
