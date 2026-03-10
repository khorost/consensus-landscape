import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    title: 'Consensus Landscape',
    description: 'Интерактивный симулятор алгоритмов консенсуса',
    lang: 'ru-RU',
    base: '/consensus-landscape/docs/',

    themeConfig: {
      nav: [
        { text: 'Документация', link: '/' },
        { text: 'Симулятор', link: '/consensus-landscape/', target: '_self' },
      ],

      sidebar: [
        {
          text: 'Введение',
          items: [
            { text: 'О проекте', link: '/' },
            { text: 'Алгоритмы консенсуса', link: '/overview' },
          ],
        },
        {
          text: 'Симуляция',
          items: [
            { text: 'Модель симуляции', link: '/simulation-model' },
          ],
        },
        {
          text: 'Реализованные алгоритмы',
          items: [
            { text: 'Raft', link: '/algorithms/raft' },
            { text: 'Basic Paxos', link: '/algorithms/paxos' },
            { text: 'Multi-Paxos', link: '/algorithms/multi-paxos' },
            { text: 'Zab (ZooKeeper)', link: '/algorithms/zab' },
            { text: 'EPaxos', link: '/algorithms/epaxos' },
          ],
        },
        {
          text: 'Справочник',
          items: [
            { text: 'Другие алгоритмы', link: '/other-algorithms' },
          ],
        },
      ],

      outline: { label: 'На этой странице' },
      docFooterText: { prev: 'Назад', next: 'Далее' },

      socialLinks: [
        { icon: 'github', link: 'https://github.com/khorost/consensus-landscape' },
      ],
    },

    ignoreDeadLinks: [
      /\/consensus-landscape\/(?:index)?$/,
    ],

    mermaid: {},
  })
);
