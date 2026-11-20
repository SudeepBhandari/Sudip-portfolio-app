import type { ProfileData, Project, ServiceItem } from '../types';

export const DEFAULT_PROFILE: ProfileData = {
  fullName: 'Sudip Bhandari',
  professionalTitle: 'Creative Graphic Designer & Digital Marketer',
  websiteDomain: 'https://www.sudipbhandari5.com.np',
  primaryEmail: 'bhandarysudip5@gmail.com',
  whatsAppNumber: '+9779840631570',
  whatsAppLink: 'https://wa.me/9779840631570',
  avatarUrl: '/assets/aistudio/sudip_3f6de287.jpeg',
  heroHeading: 'Creative Design. Meaningful Digital Experiences.',
  heroSubheading:
    'I help brands communicate through thoughtful design, engaging digital experiences, and creative marketing solutions.',
  bio: 'I am a creative professional focused on graphic design, UI/UX design, branding, video editing, and digital marketing. I create thoughtful visual experiences and digital solutions that help brands communicate effectively and stand out.',
  approach:
    'Every project begins with deep listening and understanding the core brand intent. I combine disciplined typography, spatial hierarchy, and visual balance with conversion-focused digital marketing strategy.',
  goals:
    'To collaborate with ambitious businesses and founders to craft memorable brand identities, intuitive digital products, and high-converting marketing campaigns.',
  skills: [
    'Graphic Design',
    'UI/UX Design',
    'Branding & Visual Identity',
    'Social Media Campaign Design',
    'Video Editing & Motion Graphics',
    'Digital Marketing Strategy',
    'Website Design',
    'Typography & Layout Systems'
  ],
  socialLinks: {
    linkedin: '',
    instagram: '',
    behance: '',
    dribbble: '',
    twitter: ''
  },
  cvUrl: ''
};

export const DEFAULT_SERVICES: ServiceItem[] = [
  {
    id: 'graphic-design',
    title: 'Graphic Design',
    description:
      'Compelling visual communication and print & digital design crafted to convey your brand voice with clarity and distinction.',
    deliverables: [
      'Print & Digital Collateral',
      'Posters, Banners & Editorial Layouts',
      'Vector Illustrations',
      'Production-ready Source Files'
    ],
    startingPrice: '$150'
  },
  {
    id: 'ui-ux-design',
    title: 'UI/UX Design',
    description:
      'Intuitive, aesthetically refined digital product interfaces designed for optimal user clarity, usability, and modern elegance.',
    deliverables: [
      'Mobile App & Web App UI',
      'Design Systems & Component Libraries',
      'Figma Clickable Interactive Prototypes',
      'Developer Handoff Specifications'
    ],
    startingPrice: '$350'
  },
  {
    id: 'branding-identity',
    title: 'Branding and Brand Identity',
    description:
      'Complete visual identity systems that forge an unforgettable connection with your target audience across all physical and digital touchpoints.',
    deliverables: [
      'Logo System & Variations',
      'Brand Guidelines Manual',
      'Color Palette & Typography System',
      'Stationery & Social Media Kit'
    ],
    startingPrice: '$400'
  },
  {
    id: 'social-media-design',
    title: 'Social Media Design',
    description:
      'Eye-catching social media graphics and multi-slide carousels engineered for high engagement and strong visual retention.',
    deliverables: [
      'Campaign Concept & Creative Direction',
      'Instagram / LinkedIn Carousels',
      'Promotional Banners & Story Templates',
      'Platform-optimized Asset Delivery'
    ],
    startingPrice: '$120'
  },
  {
    id: 'video-editing',
    title: 'Video Editing',
    description:
      'Dynamic pacing, cinematic cuts, color grading, and motion graphics that transform raw footage into captivating visual stories.',
    deliverables: [
      'Reels, Shorts & Social Cuts',
      'Commercial & Promotional Showreels',
      'Color Grading & Audio Mixing',
      'Motion Graphics & Subtitles'
    ],
    startingPrice: '$200'
  },
  {
    id: 'digital-marketing',
    title: 'Digital Marketing',
    description:
      'Creative marketing strategies paired with high-converting creative assets to expand your brand reach and drive measurable inbound results.',
    deliverables: [
      'Digital Ad Creative Design',
      'Marketing Funnel Visual Strategy',
      'Audience-targeted Campaign Assets',
      'A/B Test Creative Variations'
    ],
    startingPrice: '$250'
  },
  {
    id: 'website-design',
    title: 'Website Design and Creative Digital Solutions',
    description:
      'Custom, modern, and responsive website designs built with contemporary layout principles, seamless usability, and strong brand alignment.',
    deliverables: [
      'Responsive Web Layouts',
      'Landing Page & Portfolio Design',
      'Asset Optimization & Clean Export',
      'UX Flow Architecture'
    ],
    startingPrice: '$450'
  }
];

export const DEFAULT_PROJECTS: Project[] = [
  {
    id: 1,
    title: 'Aether Roasters - Artisan Coffee Packaging & Identity',
    slug: 'aether-roasters-packaging-identity',
    short_description:
      'Luxury packaging system and minimalist brand identity for a specialty micro-roastery.',
    description:
      'Aether Roasters sought a visual identity and packaging system that honored their commitment to single-origin, ethically sourced coffee beans. We developed an embossed matte-black and textured limestone color palette with gold foil stamped typography, custom tasting note labels, and collectible unboxing stationery.',
    category: 'Branding',
    tools: ['Illustrator', 'Photoshop', 'Figma', 'Print Production'],
    cover_image_key: '/assets/images/project_artisan_branding_1793694566576.jpg',
    featured: true,
    status: 'published',
    client_name: 'Aether Roasters (Sample)',
    project_url: 'https://www.sudipbhandari5.com.np',
    case_study_url: '',
    project_objective:
      'Create a distinctive tactile packaging experience that communicates premium artisanal quality on retail shelves.',
    design_process:
      'Explored geometric letterforms and luxury seal emblems, tested textured sustainable paper substrates, and finalized foil stamping specs.',
    final_outcome:
      'Elevated brand perception and delivered complete production-ready die-lines and retail packaging standards.',
    published_at: '2026-11-03T08:46:27.227Z'
  },
  {
    id: 2,
    title: 'Oakwood Capital - Wealth Management Mobile UX & UI',
    slug: 'oakwood-capital-mobile-ux',
    short_description:
      'Modern investment and wealth management interface with refined typography and data visualization.',
    description:
      'A clean mobile banking and investment experience designed to bring tranquility to financial management. Features personalized portfolio balance breakdowns, intuitive investment trajectory graphs, and tactile card interactions designed for quick comprehension.',
    category: 'UI/UX Design',
    tools: ['Figma', 'Design Systems', 'Prototyping', 'User Research'],
    cover_image_key: '/assets/images/project_fintech_uiux_1793694567220.jpg',
    featured: true,
    status: 'published',
    client_name: 'Oakwood Capital (Sample)',
    project_url: 'https://www.sudipbhandari5.com.np',
    case_study_url: '',
    project_objective:
      'Simplify complex multi-asset investment tracking into an effortless, trustworthy mobile interface.',
    design_process:
      'Conducted user journey mapping, designed high-contrast dark theme components, and developed a modular financial card architecture.',
    final_outcome:
      'Delivered 35+ responsive mobile screens and a comprehensive design system ready for engineering handoff.',
    published_at: '2026-11-03T08:46:27.227Z'
  },
  {
    id: 3,
    title: 'Monochrome & Terracotta - High Fashion Social Campaign',
    slug: 'monochrome-terracotta-fashion-campaign',
    short_description:
      'Architectural social media editorial grid and multi-slide storytelling campaign.',
    description:
      'A social media visual campaign for a contemporary autumn fashion collection. Emphasized dramatic editorial crops, oversized serif typography, and a stark black, white, and warm terracotta palette engineered to halt user scrolling.',
    category: 'Social Media Design',
    tools: ['Photoshop', 'Illustrator', 'After Effects', 'Art Direction'],
    cover_image_key: '/assets/images/project_social_campaign_1793694567912.jpg',
    featured: true,
    status: 'published',
    client_name: 'Studio M Fashion (Sample)',
    project_url: 'https://www.sudipbhandari5.com.np',
    case_study_url: '',
    project_objective:
      'Craft a cohesive, magazine-quality Instagram carousel experience for the Autumn/Winter capsule launch.',
    design_process:
      'Curated photographer lookbooks, built modular 9-tile layout grids, and balanced bold statement titles with detailed texture shots.',
    final_outcome:
      'Resulted in a signature aesthetic grid template system deployed across seasonal brand rollouts.',
    published_at: '2026-11-03T08:46:27.227Z'
  },
  {
    id: 4,
    title: 'Nexus Energy - Sustainable Tech Visual Identity & Guidelines',
    slug: 'nexus-energy-brand-identity',
    short_description:
      'Brand identity system, corporate guidelines, and growth marketing collateral for a clean tech company.',
    description:
      'Nexus Energy pioneers solar microgrids. We built their comprehensive visual identity from the ground up: an organic leaf-circuit mark, a disciplined forest green and charcoal color scheme, a 48-page brand standards guide, and digital marketing banners.',
    category: 'Graphic Design',
    tools: ['Illustrator', 'InDesign', 'Photoshop', 'Digital Marketing'],
    cover_image_key: '/assets/images/project_ecotech_growth_1793694567200.jpg',
    featured: false,
    status: 'published',
    client_name: 'Nexus Energy Corp (Sample)',
    project_url: 'https://www.sudipbhandari5.com.np',
    case_study_url: '',
    project_objective:
      'Establish a credible, modern visual identity that bridges ecological sustainability with high-tech engineering.',
    design_process:
      'Drafted iterative logomark concepts, tested legibility at micro scales, and established comprehensive multi-channel brand assets.',
    final_outcome:
      'A full brand identity system deployed across stationery, marketing decks, website, and physical collateral.',
    published_at: '2026-11-03T08:46:27.227Z'
  }
];
